/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    user: import('./db/schema.ts').User | null;
    sessionId: string | null;
  }
}