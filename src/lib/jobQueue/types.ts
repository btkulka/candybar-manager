// Job Queue type definitions

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobId = string;

export type JobType =
  | 'library-scan'
  | 'library-check'
  | 'library-health'
  | 'album-art-scan'
  | 'catalog-export'
  | 'organize-tracks'
  | 'usb-health-scan'
  | 'claude-ask'
  | 'claude-sourcing-review'
  | 'claude-track-tags'
  | 'claude-soundcloud'
  | 'claude-store-finder'
  | 'claude-upgrade-review';

// Shared result keys and their data shapes
export type SharedResultKey = 'library-file-list';

export type LibraryFileList = {
  libraryRoot: string;
  files: string[];
  discoveredAt: number;
};

export type SharedResultMap = {
  'library-file-list': LibraryFileList;
};

// Progress update sent per-job
export type JobProgress = {
  jobId: JobId;
  jobType: JobType;
  phase: string;
  current: number;
  total: number;
  message: string;
  detail?: unknown;
};

// Renderer-safe job info DTO
export type JobInfo = {
  id: JobId;
  type: JobType;
  status: JobStatus;
  progress: JobProgress | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

// Context provided to a job's run function
export type JobContext<TParams = unknown> = {
  params: TParams;
  signal: AbortSignal;
  progress: (update: Omit<JobProgress, 'jobId' | 'jobType'>) => void;
  getSharedResult: <K extends SharedResultKey>(key: K) => SharedResultMap[K] | null;
  log: (text: string, stream?: 'stdout' | 'stderr' | 'status') => void;
};

// Registration type for job definitions
export type JobDefinition<TParams = unknown, TResult = unknown> = {
  type: JobType;
  dependencies: SharedResultKey[];
  producesSharedResult?: SharedResultKey;
  /** Max execution time in ms. Job is auto-cancelled on expiry. Default: no timeout. */
  timeoutMs?: number;
  /** Jobs share a slot only with jobs in the same lane (default 'default'), so a
   *  long Claude run doesn't hold up a library scan. */
  lane?: string;
  run: (ctx: JobContext<TParams>) => Promise<TResult>;
};

// Internal job record (not exported to renderer)
export type JobRecord<TParams = unknown, TResult = unknown> = {
  id: JobId;
  type: JobType;
  status: JobStatus;
  params: TParams;
  contextKey: string;
  result: TResult | null;
  error: string | null;
  progress: JobProgress | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  abortController: AbortController;
  promise: Promise<TResult>;
  resolve: (value: TResult) => void;
  reject: (reason: Error) => void;
};
