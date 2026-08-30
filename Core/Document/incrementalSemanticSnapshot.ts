import { compareUtf16CodeUnits } from "../Ordering/ordinal";

export interface SemanticSnapshotSource<TValue> {
  readonly key: string;
  readonly dependencyKey: string;
  load(signal: AbortSignal): Promise<TValue>;
}

export interface SemanticSnapshotProgress {
  readonly completed: number;
  readonly total: number;
  readonly loaded: number;
  readonly reused: number;
  readonly key: string;
}

export interface ImmutableSemanticSnapshot<TValue> {
  readonly epoch: number;
  readonly values: readonly TValue[];
  readonly loaded: number;
  readonly reused: number;
}

export type SemanticSnapshotBuildResult<TValue> =
  | { readonly status: "applied"; readonly snapshot: ImmutableSemanticSnapshot<TValue> }
  | { readonly status: "superseded"; readonly epoch: number }
  | { readonly status: "cancelled"; readonly epoch: number };

interface CachedSemanticValue<TValue> {
  readonly dependencyKey: string;
  readonly value: TValue;
}

/**
 * Reuses semantic values strictly by stable source identity and an explicit
 * dependency key. A newer build supersedes and aborts the previous build, and
 * only a complete current build is allowed to replace the immutable snapshot.
 */
export class IncrementalSemanticSnapshotStore<TValue> {
  private cache = new Map<string, CachedSemanticValue<TValue>>();
  private epochValue = 0;
  private activeController: AbortController | undefined;
  private snapshotValue: ImmutableSemanticSnapshot<TValue> = Object.freeze({
    epoch: 0,
    values: Object.freeze([]),
    loaded: 0,
    reused: 0,
  });

  public get snapshot(): ImmutableSemanticSnapshot<TValue> {
    return this.snapshotValue;
  }

  public invalidate(): void {
    this.cache.clear();
  }

  public cancel(): void {
    this.activeController?.abort();
  }

  public async rebuild(
    sources: readonly SemanticSnapshotSource<TValue>[],
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: SemanticSnapshotProgress) => void;
    } = {},
  ): Promise<SemanticSnapshotBuildResult<TValue>> {
    const epoch = ++this.epochValue;
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    const removeAbortListener = forwardAbort(options.signal, controller);
    try {
      const ordered = [...sources].sort((left, right) => compareUtf16CodeUnits(left.key, right.key));
      assertUniqueKeys(ordered);
      const nextCache = new Map<string, CachedSemanticValue<TValue>>();
      const values: TValue[] = [];
      let loaded = 0;
      let reused = 0;
      for (const [index, source] of ordered.entries()) {
        throwIfAborted(controller.signal);
        const cached = this.cache.get(source.key);
        let value: TValue;
        if (cached?.dependencyKey === source.dependencyKey) {
          value = cached.value;
          reused += 1;
        } else {
          value = await source.load(controller.signal);
          throwIfAborted(controller.signal);
          loaded += 1;
        }
        nextCache.set(source.key, { dependencyKey: source.dependencyKey, value });
        values.push(value);
        options.onProgress?.({
          completed: index + 1,
          total: ordered.length,
          loaded,
          reused,
          key: source.key,
        });
      }
      if (epoch !== this.epochValue) {
        return { status: "superseded", epoch };
      }
      const snapshot: ImmutableSemanticSnapshot<TValue> = Object.freeze({
        epoch,
        values: Object.freeze(values),
        loaded,
        reused,
      });
      this.cache = nextCache;
      this.snapshotValue = snapshot;
      return { status: "applied", snapshot };
    } catch (errorValue) {
      if (isAbortError(errorValue) || controller.signal.aborted) {
        return { status: epoch === this.epochValue ? "cancelled" : "superseded", epoch };
      }
      throw errorValue;
    } finally {
      removeAbortListener();
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
    }
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = (): void => controller.abort();
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The semantic snapshot build was cancelled.", "AbortError");
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function assertUniqueKeys<TValue>(sources: readonly SemanticSnapshotSource<TValue>[]): void {
  for (let index = 1; index < sources.length; index += 1) {
    if (sources[index - 1]!.key === sources[index]!.key) {
      throw new Error(`Semantic snapshot source '${sources[index]!.key}' is duplicated.`);
    }
  }
}
