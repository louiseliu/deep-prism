import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";

const ZOTERO_BASE = "https://api.zotero.org";

export interface ZoteroCredentials {
  apiKey: string;
  userID: string;
  username: string;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentKey: string | false;
  itemCount: number;
}

/** Result of importing a collection */
export interface CollectionImportResult {
  bibtex: string;
  libraryVersion: number;
  keyMap: Record<string, string>;
  totalItems: number;
}

/** Result of an incremental sync */
export interface CollectionSyncResult {
  updatedEntries: { key: string; citekey: string; bibtex: string }[];
  deletedKeys: string[];
  libraryVersion: number;
}

// ─── OAuth Flow (via Tauri Rust backend) ───

export async function startOAuth(): Promise<void> {
  const result = await invoke<{ authorize_url: string }>("zotero_start_oauth");
  await open(result.authorize_url);
}

export async function completeOAuth(): Promise<ZoteroCredentials> {
  const result = await invoke<{
    api_key: string;
    user_id: string;
    username: string;
  }>("zotero_complete_oauth");
  return {
    apiKey: result.api_key,
    userID: result.user_id,
    username: result.username,
  };
}

export async function cancelOAuth(): Promise<void> {
  await invoke("zotero_cancel_oauth");
}

// ─── Zotero Web API v3 ───

async function zoteroFetch(
  apiKey: string,
  path: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const response = await fetch(`${ZOTERO_BASE}${path}`, {
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
      ...headers,
    },
  });
  if (!response.ok) {
    if (response.status === 304) return response;
    if (response.status === 403) throw new Error("Invalid or expired API key");
    throw new Error(`Zotero API error: ${response.status}`);
  }
  return response;
}

function extractCitekey(bibtex: string): string {
  const match = bibtex.match(/@\w+\{([^,\s]+)/);
  return match ? match[1] : "";
}

export async function validateApiKey(
  apiKey: string,
): Promise<ZoteroCredentials> {
  const response = await zoteroFetch(apiKey, "/keys/current");
  const data = await response.json();
  return {
    apiKey,
    userID: String(data.userID),
    username: data.username ?? "",
  };
}

// ─── Collections ───

export async function fetchCollections(
  apiKey: string,
  userID: string,
): Promise<ZoteroCollection[]> {
  const response = await zoteroFetch(
    apiKey,
    `/users/${userID}/collections?format=json`,
  );
  const data = (await response.json()) as {
    key: string;
    data: { key: string; name: string; parentCollection: string | false };
    meta: { numItems: number };
  }[];
  return data.map((c) => ({
    key: c.key,
    name: c.data.name,
    parentKey: c.data.parentCollection,
    itemCount: c.meta.numItems,
  }));
}

// ─── Collection Import (full download) ───

/**
 * Import all items from a specific collection.
 * Pass collectionKey = null to import the entire "My Library" (all top-level items).
 */
export async function importCollection(
  apiKey: string,
  userID: string,
  collectionKey: string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionImportResult> {
  const basePath = collectionKey
    ? `/users/${userID}/collections/${collectionKey}/items/top`
    : `/users/${userID}/items/top`;

  let allBibtex = "";
  const keyMap: Record<string, string> = {};
  let start = 0;
  const limit = 100;
  let total = 0;
  let libraryVersion = 0;

  while (true) {
    const params = new URLSearchParams({
      format: "json",
      include: "bibtex",
      limit: String(limit),
      start: String(start),
    });
    const response = await zoteroFetch(apiKey, `${basePath}?${params}`);

    if (start === 0) {
      total = Number(response.headers.get("Total-Results") ?? 0);
      libraryVersion = Number(
        response.headers.get("Last-Modified-Version") ?? 0,
      );
    }

    const items = (await response.json()) as { key: string; bibtex?: string }[];
    if (items.length === 0) break;

    for (const item of items) {
      const bibtex = item.bibtex ?? "";
      if (!bibtex.trim()) continue;
      const citekey = extractCitekey(bibtex);
      if (citekey) keyMap[item.key] = citekey;
      allBibtex += (allBibtex ? "\n\n" : "") + bibtex;
    }

    start += limit;
    onProgress?.(Math.min(start, total), total);
    if (start >= total) break;
  }

  return { bibtex: allBibtex, libraryVersion, keyMap, totalItems: total };
}

// ─── Incremental Sync ───

/**
 * Sync changes for a specific collection since lastVersion.
 * collectionKey = null syncs the entire library.
 *
 * Note: Zotero's `since` param works at the library level (not per-collection),
 * so for collection sync we re-fetch all collection items and diff locally.
 */
export async function syncCollection(
  apiKey: string,
  userID: string,
  collectionKey: string | null,
  lastVersion: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionSyncResult> {
  // For "My Library" (all items), we can use the `since` param
  if (!collectionKey) {
    return syncFullLibrary(apiKey, userID, lastVersion, onProgress);
  }

  // For a specific collection, re-fetch all items and diff against keyMap
  // (Zotero API doesn't support `since` scoped to a collection)
  const result = await importCollection(
    apiKey,
    userID,
    collectionKey,
    onProgress,
  );

  return {
    updatedEntries: Object.entries(result.keyMap).map(([key, citekey]) => {
      // Extract the bibtex for this citekey from the full bibtex string
      const bibtexEntries = result.bibtex.split(/\n(?=@)/);
      const entry =
        bibtexEntries.find((e) => extractCitekey(e) === citekey) ?? "";
      return { key, citekey, bibtex: entry };
    }),
    deletedKeys: [],
    libraryVersion: result.libraryVersion,
  };
}

async function syncFullLibrary(
  apiKey: string,
  userID: string,
  lastVersion: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionSyncResult> {
  const updatedEntries: CollectionSyncResult["updatedEntries"] = [];
  let start = 0;
  const limit = 100;
  let total = 0;
  let newVersion = lastVersion;

  while (true) {
    const params = new URLSearchParams({
      since: String(lastVersion),
      format: "json",
      include: "bibtex",
      limit: String(limit),
      start: String(start),
    });
    const response = await zoteroFetch(
      apiKey,
      `/users/${userID}/items/top?${params}`,
    );

    if (start === 0) {
      total = Number(response.headers.get("Total-Results") ?? 0);
      newVersion = Number(
        response.headers.get("Last-Modified-Version") ?? lastVersion,
      );
    }

    const items = (await response.json()) as { key: string; bibtex?: string }[];
    if (items.length === 0) break;

    for (const item of items) {
      const bibtex = item.bibtex ?? "";
      if (!bibtex.trim()) continue;
      const citekey = extractCitekey(bibtex);
      updatedEntries.push({ key: item.key, citekey, bibtex });
    }

    start += limit;
    onProgress?.(Math.min(start, total), total);
    if (start >= total) break;
  }

  // Fetch deleted items
  const deletedResponse = await zoteroFetch(
    apiKey,
    `/users/${userID}/deleted?since=${lastVersion}`,
  );
  const deleted = (await deletedResponse.json()) as { items?: string[] };
  const deletedKeys = deleted.items ?? [];

  if (!newVersion || newVersion === lastVersion) {
    newVersion = Number(
      deletedResponse.headers.get("Last-Modified-Version") ?? lastVersion,
    );
  }

  return { updatedEntries, deletedKeys, libraryVersion: newVersion };
}

// ─── Zotero Local Client API (via Tauri backend proxy) ───

interface LocalFetchResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

async function localFetch(path: string): Promise<Response> {
  const result = await invoke<LocalFetchResponse>("zotero_local_fetch", {
    request: { path: `/api${path}` },
  });
  if (result.status >= 400) {
    throw new Error(`Zotero 本地 API 错误: ${result.status} (${path})`);
  }
  const headers = new Headers(result.headers);
  return new Response(result.body, { status: result.status, headers });
}

export async function checkLocalZotero(): Promise<boolean> {
  try {
    return await invoke<boolean>("zotero_local_ping");
  } catch {
    return false;
  }
}

export async function connectLocalZotero(): Promise<ZoteroCredentials> {
  const isRunning = await checkLocalZotero();
  if (!isRunning) {
    throw new Error("未检测到 Zotero 客户端，请确保 Zotero 已启动");
  }
  try {
    await localFetch("/users/0/collections?limit=1");
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    if (detail.includes("403") || detail.includes("404")) {
      throw new Error("Zotero 本地 API 未启用，请在 Zotero 偏好设置 → 高级 中启用「允许其他应用通信」");
    }
    throw new Error(`无法访问 Zotero 本地 API: ${detail}`);
  }
  return {
    apiKey: "__local__",
    userID: "0",
    username: "本地客户端",
  };
}

export async function fetchLocalCollections(): Promise<ZoteroCollection[]> {
  const response = await localFetch("/users/0/collections?format=json");
  const data = (await response.json()) as {
    key: string;
    data: { key: string; name: string; parentCollection: string | false };
    meta: { numCollections: number; numItems: number };
  }[];
  return data.map((c) => ({
    key: c.key,
    name: c.data.name,
    parentKey: c.data.parentCollection,
    itemCount: c.meta.numItems,
  }));
}

export async function fetchLocalLibraryItemCount(): Promise<number> {
  const response = await localFetch("/users/0/items/top?format=json&limit=1");
  const total = response.headers.get("Total-Results");
  return total ? Number(total) : 0;
}

export interface ZoteroItem {
  key: string;
  title: string;
  creators: string;
  year: string;
  itemType: string;
}

export async function fetchLocalItems(
  collectionKey: string | null,
  limit = 50,
  start = 0,
): Promise<{ items: ZoteroItem[]; total: number }> {
  const basePath = collectionKey
    ? `/users/0/collections/${collectionKey}/items/top`
    : `/users/0/items/top`;
  const params = new URLSearchParams({
    format: "json",
    limit: String(limit),
    start: String(start),
  });
  const response = await localFetch(`${basePath}?${params}`);
  const total = Number(response.headers.get("Total-Results") ?? 0);
  const data = (await response.json()) as {
    key: string;
    data: {
      key: string;
      title: string;
      itemType: string;
      creators?: { firstName?: string; lastName?: string; name?: string }[];
      date?: string;
    };
  }[];
  const items: ZoteroItem[] = data.map((item) => {
    const creators = (item.data.creators ?? [])
      .map((c) => c.name ?? [c.lastName, c.firstName].filter(Boolean).join(" "))
      .slice(0, 3)
      .join(", ");
    const yearMatch = (item.data.date ?? "").match(/\d{4}/);
    return {
      key: item.key,
      title: item.data.title || "无标题",
      creators: creators || "未知作者",
      year: yearMatch ? yearMatch[0] : "",
      itemType: item.data.itemType,
    };
  });
  return { items, total };
}

export async function importLocalCollection(
  collectionKey: string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionImportResult> {
  const basePath = collectionKey
    ? `/users/0/collections/${collectionKey}/items/top`
    : `/users/0/items/top`;

  let allBibtex = "";
  const keyMap: Record<string, string> = {};
  let start = 0;
  const limit = 100;
  let total = 0;
  let libraryVersion = 0;

  while (true) {
    const params = new URLSearchParams({
      format: "json",
      include: "bibtex",
      limit: String(limit),
      start: String(start),
    });
    const response = await localFetch(`${basePath}?${params}`);

    if (start === 0) {
      total = Number(response.headers.get("Total-Results") ?? 0);
      libraryVersion = Number(
        response.headers.get("Last-Modified-Version") ?? 0,
      );
    }

    const items = (await response.json()) as { key: string; bibtex?: string }[];
    if (items.length === 0) break;

    for (const item of items) {
      const bibtex = item.bibtex ?? "";
      if (!bibtex.trim()) continue;
      const citekey = extractCitekey(bibtex);
      if (citekey) keyMap[item.key] = citekey;
      allBibtex += (allBibtex ? "\n\n" : "") + bibtex;
    }

    start += limit;
    onProgress?.(Math.min(start, total), total);
    if (start >= total) break;
  }

  return { bibtex: allBibtex, libraryVersion, keyMap, totalItems: total };
}

export async function syncLocalCollection(
  collectionKey: string | null,
  lastVersion: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionSyncResult> {
  if (!collectionKey) {
    const updatedEntries: CollectionSyncResult["updatedEntries"] = [];
    let start = 0;
    const limit = 100;
    let total = 0;
    let newVersion = lastVersion;

    while (true) {
      const params = new URLSearchParams({
        since: String(lastVersion),
        format: "json",
        include: "bibtex",
        limit: String(limit),
        start: String(start),
      });
      const response = await localFetch(`/users/0/items/top?${params}`);

      if (start === 0) {
        total = Number(response.headers.get("Total-Results") ?? 0);
        newVersion = Number(
          response.headers.get("Last-Modified-Version") ?? lastVersion,
        );
      }

      const items = (await response.json()) as { key: string; bibtex?: string }[];
      if (items.length === 0) break;

      for (const item of items) {
        const bibtex = item.bibtex ?? "";
        if (!bibtex.trim()) continue;
        const citekey = extractCitekey(bibtex);
        updatedEntries.push({ key: item.key, citekey, bibtex });
      }

      start += limit;
      onProgress?.(Math.min(start, total), total);
      if (start >= total) break;
    }

    let deletedKeys: string[] = [];
    try {
      const deletedResponse = await localFetch(
        `/users/0/deleted?since=${lastVersion}`,
      );
      const deleted = (await deletedResponse.json()) as { items?: string[] };
      deletedKeys = deleted.items ?? [];
    } catch {
      // Zotero local API may not support /deleted endpoint
    }

    return {
      updatedEntries,
      deletedKeys,
      libraryVersion: newVersion,
    };
  }

  const result = await importLocalCollection(collectionKey, onProgress);
  return {
    updatedEntries: Object.entries(result.keyMap).map(([key, citekey]) => {
      const bibtexEntries = result.bibtex.split(/\n(?=@)/);
      const entry =
        bibtexEntries.find((e) => extractCitekey(e) === citekey) ?? "";
      return { key, citekey, bibtex: entry };
    }),
    deletedKeys: [],
    libraryVersion: result.libraryVersion,
  };
}
