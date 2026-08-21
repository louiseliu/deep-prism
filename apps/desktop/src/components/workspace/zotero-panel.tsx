import { useEffect, useState, useCallback } from "react";
import {
  SettingsIcon,
  DownloadIcon,
  LoaderIcon,
  LogOutIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  LinkIcon,
  KeyIcon,
  UserIcon,
  FolderIcon,
  LibraryIcon,
  CheckIcon,
  XIcon,
  ChevronRightIcon,
  FileTextIcon,
} from "lucide-react";
import { useZoteroStore, type CollectionSyncInfo } from "@/stores/zotero-store";
import { useDocumentStore } from "@/stores/document-store";
import { fetchLocalItems, type ZoteroItem } from "@/lib/zotero-api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MYLIB_KEY = "__my_library__";

export function ZoteroPanel() {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const _username = useZoteroStore((s) => s.username);
  const isValidating = useZoteroStore((s) => s.isValidating);
  const isSyncing = useZoteroStore((s) => s.isSyncing);
  const syncProgress = useZoteroStore((s) => s.syncProgress);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const allSyncedCollections = useZoteroStore((s) => s.syncedCollections);
  const syncedCollections = projectRoot
    ? (allSyncedCollections[projectRoot] ?? {})
    : {};
  const error = useZoteroStore((s) => s.error);
  const collections = useZoteroStore((s) => s.collections);
  const libraryItemCount = useZoteroStore((s) => s.libraryItemCount);
  const isLoadingCollections = useZoteroStore((s) => s.isLoadingCollections);
  const connectWithOAuth = useZoteroStore((s) => s.connectWithOAuth);
  const cancelConnect = useZoteroStore((s) => s.cancelConnect);
  const _disconnect = useZoteroStore((s) => s.disconnect);
  const revalidate = useZoteroStore((s) => s.revalidate);
  const _loadCollections = useZoteroStore((s) => s.loadCollections);
  const importCollectionToBib = useZoteroStore((s) => s.importCollectionToBib);
  const syncCollectionBib = useZoteroStore((s) => s.syncCollectionBib);
  const removeCollection = useZoteroStore((s) => s.removeCollection);

  const [connectDialogOpen, setConnectDialogOpen] = useState(false);

  useEffect(() => {
    const { apiKey } = useZoteroStore.getState();
    if (apiKey) revalidate();
  }, [revalidate]);

  const topCollections = collections.filter((c) => c.parentKey === false);

  return (
    <div className="flex h-full flex-col">
      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!isAuthenticated ? (
          <NotConnectedView
            isValidating={isValidating}
            error={error}
            onConnect={connectWithOAuth}
            onCancel={cancelConnect}
            onApiKey={() => setConnectDialogOpen(true)}
            onLocalConnect={useZoteroStore.getState().connectLocalClient}
          />
        ) : (
          <div className="py-0.5">
            {/* Error */}
            {error && (
              <div className="mx-2 mb-1 rounded bg-destructive/10 px-2 py-1 text-destructive text-xs">
                {error}
              </div>
            )}

            {/* Syncing progress */}
            {isSyncing && (
              <div className="mx-2 mb-0.5 flex items-center gap-1 text-muted-foreground text-xs">
                <LoaderIcon className="size-3 animate-spin" />
                {syncProgress
                  ? `${syncProgress.loaded}/${syncProgress.total}`
                  : "同步中..."}
              </div>
            )}

            {/* My Library */}
            <CollectionRow
              collectionKey={null}
              name="我的文献库"
              icon={<LibraryIcon className="size-3.5" />}
              itemCount={libraryItemCount || undefined}
              syncInfo={syncedCollections[MYLIB_KEY]}
              isSyncing={isSyncing === MYLIB_KEY}
              onImport={() => importCollectionToBib(null, "我的文献库")}
              onSync={() => syncCollectionBib(null)}
              onRemove={() => removeCollection(null)}
              disabled={!!isSyncing}
            />

            {topCollections.length > 0 && (
              <div className="mx-2 my-0.5 border-sidebar-border border-t" />
            )}

            {isLoadingCollections ? (
              <div className="flex items-center gap-1 px-2 py-1 text-muted-foreground text-xs">
                <LoaderIcon className="size-3 animate-spin" />
                加载中...
              </div>
            ) : (
              topCollections.map((col) => (
                <CollectionRow
                  key={col.key}
                  collectionKey={col.key}
                  name={col.name}
                  icon={<FolderIcon className="size-3.5" />}
                  itemCount={col.itemCount}
                  syncInfo={syncedCollections[col.key]}
                  isSyncing={isSyncing === col.key}
                  onImport={() => importCollectionToBib(col.key, col.name)}
                  onSync={() => syncCollectionBib(col.key)}
                  onRemove={() => removeCollection(col.key)}
                  disabled={!!isSyncing}
                />
              ))
            )}
          </div>
        )}
      </div>

      <ZoteroApiKeyDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
      />
    </div>
  );
}

/** Header rendered separately by Sidebar so it sits outside the resizable panel content */
export function ZoteroHeader() {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const username = useZoteroStore((s) => s.username);
  const isLoadingCollections = useZoteroStore((s) => s.isLoadingCollections);
  const disconnect = useZoteroStore((s) => s.disconnect);
  const loadCollections = useZoteroStore((s) => s.loadCollections);

  return (
    <div className="relative flex w-full items-center justify-center px-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            isAuthenticated ? "bg-green-500" : "bg-muted-foreground/30",
          )}
        />
        <span className="font-medium text-xs">Zotero</span>
      </div>
      {isAuthenticated && (
        <div className="absolute right-3 flex items-center gap-1">
          <button
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            onClick={loadCollections}
            title="刷新"
          >
            <RefreshCwIcon
              className={cn("size-3.5", isLoadingCollections && "animate-spin")}
            />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
                <SettingsIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <div className="flex items-center gap-2 px-2 py-1">
                <UserIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate text-muted-foreground text-xs">
                  {username}
                </span>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={disconnect}>
                <LogOutIcon className="mr-2 size-3.5" />
                断开连接
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

// ─── Not Connected View ───

function NotConnectedView({
  isValidating,
  error,
  onConnect,
  onCancel,
  onApiKey,
  onLocalConnect,
}: {
  isValidating: boolean;
  error: string | null;
  onConnect: () => void;
  onCancel: () => void;
  onApiKey: () => void;
  onLocalConnect: () => Promise<boolean>;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full bg-muted">
        <LinkIcon className="size-4 text-muted-foreground" />
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        连接 Zotero 导入参考文献
      </p>
      {isValidating ? (
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderIcon className="size-3 animate-spin" />
            连接中...
          </div>
          <button
            className="text-[10px] text-muted-foreground underline"
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1.5">
          <Button
            size="sm"
            className="h-6 gap-1 text-[11px]"
            onClick={() => { onLocalConnect(); }}
          >
            <LinkIcon className="size-3" />
            连接本地客户端
          </Button>
          <div className="flex items-center gap-2">
            <button
              className="text-[10px] text-muted-foreground underline"
              onClick={onApiKey}
            >
              API 密钥
            </button>
            <span className="text-[10px] text-muted-foreground/50">|</span>
            <button
              className="text-[10px] text-muted-foreground underline"
              onClick={onConnect}
            >
              OAuth
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

// ─── Collection Row ───

function CollectionRow({
  collectionKey,
  name,
  icon,
  itemCount,
  syncInfo,
  isSyncing,
  onImport,
  onSync,
  onRemove,
  disabled,
}: {
  collectionKey: string | null;
  name: string;
  icon: React.ReactNode;
  itemCount?: number;
  syncInfo?: CollectionSyncInfo;
  isSyncing: boolean;
  onImport: () => void;
  onSync: () => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const isSynced = !!syncInfo;
  const apiKey = useZoteroStore((s) => s.apiKey);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ZoteroItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [totalItems, setTotalItems] = useState(0);

  const loadItems = useCallback(async () => {
    if (apiKey !== "__local__") return;
    setLoadingItems(true);
    try {
      const result = await fetchLocalItems(collectionKey, 50, 0);
      setItems(result.items);
      setTotalItems(result.total);
    } catch {
      // ignore
    } finally {
      setLoadingItems(false);
    }
  }, [apiKey, collectionKey]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && items.length === 0) {
      loadItems();
    }
  };

  return (
    <div>
      <div className="group flex items-center gap-1 px-2 py-0.5">
        <button
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={handleToggle}
        >
          <ChevronRightIcon
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1" onClick={handleToggle} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") handleToggle(); }}>
          <div className="flex items-center gap-1">
            <span className="truncate text-foreground text-sm">{name}</span>
            {isSynced && (
              <CheckIcon className="size-2.5 shrink-0 text-muted-foreground" />
            )}
          </div>
          {isSynced && (
            <p className="truncate text-muted-foreground text-xs leading-none">
              {syncInfo.bibFileName}
            </p>
          )}
          {!isSynced && itemCount !== undefined && (
            <p className="text-muted-foreground text-xs leading-none">
              {itemCount} 条
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {isSynced ? (
            <>
              <button
                className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-30"
                onClick={onSync}
                disabled={disabled}
                title="同步"
              >
                {isSyncing ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
              </button>
              <button
                className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-30"
                onClick={onRemove}
                disabled={disabled}
                title="移除"
              >
                <XIcon className="size-3" />
              </button>
            </>
          ) : (
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-30"
              onClick={onImport}
              disabled={disabled}
              title="导入"
            >
              <DownloadIcon className="size-3" />
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="ml-6 border-l border-sidebar-border pl-2">
          {loadingItems ? (
            <div className="flex items-center gap-1 py-1 text-muted-foreground text-xs">
              <LoaderIcon className="size-3 animate-spin" />
              加载中...
            </div>
          ) : items.length === 0 ? (
            <p className="py-1 text-muted-foreground text-xs">暂无文献</p>
          ) : (
            <>
              {items.map((item) => (
                <div key={item.key} className="flex items-start gap-1.5 py-0.5">
                  <FileTextIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-foreground text-xs leading-snug">
                      {item.title}
                    </p>
                    <p className="truncate text-muted-foreground text-[10px] leading-snug">
                      {item.creators}{item.year ? ` (${item.year})` : ""}
                    </p>
                  </div>
                </div>
              ))}
              {totalItems > items.length && (
                <p className="py-0.5 text-muted-foreground text-[10px]">
                  还有 {totalItems - items.length} 条...
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── API Key Dialog ───

function ZoteroApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const connect = useZoteroStore((s) => s.connectWithApiKey);
  const isValidating = useZoteroStore((s) => s.isValidating);
  const error = useZoteroStore((s) => s.error);

  const handleConnect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    const success = await connect(key);
    if (success) {
      onOpenChange(false);
      setApiKey("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>连接 Zotero</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <p className="text-muted-foreground text-sm">
            输入你的 Zotero API 密钥。
          </p>
          <Input
            type="password"
            placeholder="Zotero API 密钥"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConnect();
            }}
            autoFocus
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
          <p className="text-muted-foreground text-xs">
            在此创建密钥：{" "}
            <a
              href="https://www.zotero.org/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              zotero.org/settings/keys
            </a>
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!apiKey.trim() || isValidating}
          >
            {isValidating ? "验证中..." : "连接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
