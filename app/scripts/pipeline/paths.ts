/**
 * Where the pipeline keeps things.
 *
 *   CACHE_ROOT  downloaded inputs and baselines, reused across runs
 *   BUILD_DIR   what a run produces; copied into app/data only to publish, so
 *               app/data keeps matching the sync production serves meanwhile
 *     core/     the source-of-truth tables (taxa, assessments, links, counts)
 *     data/     what the app reads, built from core/ (same layout as app/data)
 */

import * as os from "os";
import * as path from "path";

export const CACHE_ROOT = path.join(os.homedir(), ".cache", "redlist-dashboard");
export const BUILD_DIR = process.env.PIPELINE_BUILD_DIR ?? path.join(CACHE_ROOT, "build");
export const CORE_DIR = path.join(BUILD_DIR, "core");
export const OUT_DIR = path.join(BUILD_DIR, "data");
