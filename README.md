# QueueCTL

i implemented CLI job queue system for backend assignment. i have used Node.js + SQLite for jobs, workers, retries, DLQ, and persistence.

## Setup Instructions

1. `npm install` .
2. `node queuectl.js --help`.
3. `queue.db` creates automaticaly.

Windows PowerShell: `node queuectl.js enqueue "{\"id\":\"job1\",\"command\":\"echo hi\"}"`.(use this format for jason as the shell supports only this format)

For logs: `node worker.js` direct.

## Usage Examples

### Help command
command:- node queuectl.js --help
Output:-

<img width="953" height="403" alt="image" src="https://github.com/user-attachments/assets/6e3cf2e8-f12e-48c5-813e-9d191cecfbea" />

### Enqueue
Command:- node queuectl enqueue '{"id":"job1","command":"sleep 2"}'
Output:-

<img width="1197" height="46" alt="image" src="https://github.com/user-attachments/assets/626ebb42-f3f4-4fe3-a0bd-b69a46d2341d" />

### Start Workers
Command:- node queuectl worker start --count 2
Output:-

<img width="887" height="46" alt="image" src="https://github.com/user-attachments/assets/3e5babcb-8f8b-4b7a-9ac1-56ab038f1050" />

### Start working
the below command also create worker
Command:- node worker.js 
Output:-  

<img width="681" height="391" alt="image" src="https://github.com/user-attachments/assets/17566ca3-d2d9-4a29-b8a3-b5817a158f85" />

### Stop workers
Command:- node queuectl worker stop
Output:-

<img width="767" height="54" alt="image" src="https://github.com/user-attachments/assets/f9d7d7ff-119a-4936-ab08-603c4fc4fbdb" />

### Check status
Command:- node queuectl.js status
Output:-

<img width="741" height="246" alt="image" src="https://github.com/user-attachments/assets/acb602d8-6d50-4b88-95e2-5e369b6045c7" />

### List Jobs
Command:- node queuectl.js list
Output:-

<img width="1619" height="152" alt="image" src="https://github.com/user-attachments/assets/a75e0ceb-3ccb-4b7a-9fde-ebb420a01725" />

### DLQ
Before checking this enqueue a failed job i.e node queuectl.js enqueue "{\"id\":\"fail1\",\"command\":\"false\"}"
1.now check dlq before starting worker
Command:- node queuectl.js dlq list
Output:- 

<img width="776" height="54" alt="image" src="https://github.com/user-attachments/assets/66a4033d-7335-4fe5-ad0a-619fc6f92a61" />

2.start worker and let it try all attempts and move the job to dlq
command:- node worker.js
final output:-

<img width="768" height="172" alt="image" src="https://github.com/user-attachments/assets/3f562956-fa55-40fe-bbda-92140c6703c9" />

now check the status
command:- queuectl.js dlq list
output:-

<img width="1556" height="146" alt="image" src="https://github.com/user-attachments/assets/2080012e-47f4-4507-aec7-179ddfdc49ff" />

3.if we retry dlq jobs it moves them to pending state
Command:- node queuectl.js dlq retry fail1
Output:-

<img width="864" height="52" alt="image" src="https://github.com/user-attachments/assets/1563b9e7-0ce1-4ea4-8f66-a89017ac83dc" />

4. to verify status once check all jobs status
Command:- node queuectl.js status
Output:-

<img width="879" height="275" alt="image" src="https://github.com/user-attachments/assets/5ed74e80-06be-4c80-994b-aff6c8c65f42" />

### Config command
Command:- node queuectl.js config set max-retries 5
Output:-

<img width="1116" height="69" alt="image" src="https://github.com/user-attachments/assets/6cf1b0af-b9ad-496c-9d97-38e52d14cb75" />

These are all the commands available.

## Challenges Faced

During development and testing (mostly on Windows PowerShell), I hit a few key issues. Here's what I encountered and how I fixed them:

a. **JSON Quoting in PowerShell**: Enqueuing failed with parse errors—PowerShell parsed `{...}` as hashtables or expanded `!` in strings.  
   *Fix*: Used escaped double quotes (`\"{...}\"`) for JSON args; tested in CMD for cross-terminal stability.

b. **Silent Worker Logs**: Spawned workers (`worker start`) didn't output to console on Windows due to stdio buffering.  
   *Fix*: Added verbose PID/timestamp prints in `worker.js`; recommended direct `node worker.js` for debugging.

c. **Retry Logic Skipping Failed Jobs**: Workers only polled `pending` state, ignoring `failed` jobs for backoff retries.  
   *Fix*: Updated `acquireJob` query in `db.js` to `(state = 'pending' OR state = 'failed') AND next_attempt_at <= now`.

d. **DB Locking Timeouts**: Multiple workers caused transaction deadlocks in SQLite.  
   *Fix*: Enabled WAL mode and 5s busy_timeout in DB init for better concurrency.

e. **Infinite Shutdown Loop on Ctrl+C**: SIGINT handler looped endlessly in shutdown mode.  
   *Fix*: Added 10s timeout with elapsed logging in `worker.js` to force exit.


## Architecture Overview

- **Lifecycle**: pending → processing (poll/acquire) → completed or failed (backoff next_attempt_at = base^attempts s) → dead (DLQ after max_retries).
- **Persistence**: SQLite `queue.db` (jobs/states/timestamps, config, PIDs). WAL for concurrency.
- **Workers**: Poll 1s for pending/failed; DB transaction locks. Spawn command (shell:true). SIGTERM finishes current.

## Assumptions & Trade-offs

Single machine (SQLite).
Polling (no Redis).
Unix cmds (Windows shell). 
Console logs. 
No priorities. 
Config on poll.

## Testing Instructions

1. **Basic Complete**: Enqueue `{"command":"echo ok"}`, `node worker.js` (~2s, Ctrl+C) → status completed:1.

2. **Failed Retries/DLQ**: Enqueue `{"command":"false"}`, `node worker.js` (~15s) → dead:1, dlq list shows.

3. **Multi-Workers No Overlap**: Enqueue 3 (echo, sleep 3, echo), 2x `node worker.js` (~5s) → status completed:3, logs different jobs.

4. **Invalid Fail**: Enqueue `{"command":"nonexistent"}`, `node worker.js` (~15s) → DLQ, logs error no crash.

5. **Restart Survives**: Enqueue false, `node worker.js` (to failed, Ctrl+C), reopen terminal → status failed:1, worker resumes.

Reset: `del queue.db`.
