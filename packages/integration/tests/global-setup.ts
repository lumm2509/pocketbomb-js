import type { TestProject } from "vitest/node";
import { startFuse } from "pocketbomb-fuse/node";
import { monorepoFuseOptions } from "../../../scripts/pocketbomb-server.ts";

export default async function setup(project: TestProject) {
  const fuse = await startFuse(monorepoFuseOptions());

  project.provide("pbURL", fuse.url);

  return () => fuse.stop();
}

declare module "vitest" {
  export interface ProvidedContext {
    pbURL: string;
  }
}
