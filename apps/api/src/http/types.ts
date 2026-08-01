import type { AppConfig } from "@audiotool/config";
import type { AudioToolDatabase } from "@audiotool/database";

import type { JobEventHub } from "../services/event-hub.js";
import type { JobDispatcher } from "../services/job-dispatcher.js";
import type { MlProvider } from "../services/ml-provider.js";
import type { AudioStorageService } from "../services/storage.js";

export interface ApiContext {
  config: AppConfig;
  db: AudioToolDatabase;
  storage: AudioStorageService;
  provider: MlProvider;
  eventHub: JobEventHub;
  jobProcessor: JobDispatcher;
}
