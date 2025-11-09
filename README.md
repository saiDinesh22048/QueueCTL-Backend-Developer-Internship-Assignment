# QueueCTL

CLI job queue system for backend assignment. Node.js + SQLite for jobs, workers, retries, DLQ, and persistence.

## Setup Instructions

1. `npm install` (Node v18+).
2. `node queuectl.js --help`.
3. `queue.db` auto-creates.

Windows PS: `node queuectl.js enqueue "{\"id\":\"job1\",\"command\":\"echo hi\"}"`.

For logs: `node worker.js` direct.

## Usage Examples

### Enqueue











Output: `Set max-retries = 5`

## Architecture Overview

- **Lifecycle**: pending → processing (poll/acquire) → completed or failed (backoff next_attempt_at = base^attempts s) → dead (DLQ after max_retries).
- **Persistence**: SQLite `queue.db` (jobs/states/timestamps, config, PIDs). WAL for concurrency.
- **Workers**: Poll 1s for pending/failed; DB transaction locks. Spawn command (shell:true). SIGTERM finishes current.

## Assumptions & Trade-offs

Single machine (SQLite). Polling (no Redis). Unix cmds (Windows shell). Console logs. No priorities. Config on poll.

## Testing Instructions

1. **Basic Complete**: Enqueue `{"command":"echo ok"}`, `node worker.js` (~2s, Ctrl+C) → status completed:1.

2. **Failed Retries/DLQ**: Enqueue `{"command":"false"}`, `node worker.js` (~15s) → dead:1, dlq list shows.

3. **Multi-Workers No Overlap**: Enqueue 3 (echo, sleep 3, echo), 2x `node worker.js` (~5s) → status completed:3, logs different jobs.

4. **Invalid Fail**: Enqueue `{"command":"nonexistent"}`, `node worker.js` (~15s) → DLQ, logs error no crash.

5. **Restart Survives**: Enqueue false, `node worker.js` (to failed, Ctrl+C), reopen terminal → status failed:1, worker resumes.

Reset: `del queue.db`.
