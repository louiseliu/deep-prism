import type { FallbackProps } from "react-error-boundary";

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl space-y-4">
        <h1 className="font-bold text-2xl text-destructive">
          出现了问题
        </h1>
        <p className="text-muted-foreground text-sm">
          发生了意外错误。您可以重试或重新加载应用。
        </p>

        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-4 text-xs">
          {error instanceof Error
            ? `${error.message}${error.stack ? `\n\n${error.stack}` : ""}`
            : String(error)}
        </pre>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm hover:bg-primary/90"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border px-4 py-2 font-medium text-sm hover:bg-accent"
          >
            重新加载
          </button>
        </div>
      </div>
    </div>
  );
}
