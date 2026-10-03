/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    user: import('./lib/auth.ts').SessionUser | null;
    sessionId: string | null;
    trackedPostId?: string | null;
    trackedPath?: string;
  }
}