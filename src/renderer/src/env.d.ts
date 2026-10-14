/// <reference types="vite/client" />

import type { MoireApi } from "../../preload";

declare global {
  interface Window {
    moire: MoireApi;
  }
}
