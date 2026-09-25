import { parseArgs } from 'node:util';
import { runFromEnv } from '../src/app.js';
import { jsonLog, silentLog } from '../src/log.js';
import { loadLocalEnv } from './env.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

if (values['dry-run'] && values.live) {
  console.error('Pass either --dry-run or --live, not both.');
  process.exit(2);
}

loadLocalEnv();

try {
  const summary = await runFromEnv(process.env, {
    forceDryRun: values['dry-run'],
    forceLive: values.live,
    log: values.quiet || values.json ? silentLog : jsonLog,
  });
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n${summary.dryRun ? 'DRY RUN (no writes)' : 'LIVE'} via ${summary.jevModel} on Vercel AI Gateway`);
    console.log(`folders=${summary.folders} targets=${summary.targetFolders} bookmarks=${summary.bookmarksListed} unfiled=${summary.unfiled} classified=${summary.classified}`);
    console.log('counts:', summary.counts);
    if (!summary.dryRun) console.log('writes:', summary.writes);
    for (const action of summary.actions.filter(a => a.kind === 'file')) {
      const p = action.probability?.toFixed(2) ?? '-';
      console.log(`  ${action.kind.padEnd(15)} ${action.tweetId} -> ${action.targetFolderName} (p=${p}) ${action.author ?? ''} ${action.preview}`);
    }
  }
  if (summary.aborted) process.exitCode = 1;
} catch (error) {
  console.error(`sort failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
