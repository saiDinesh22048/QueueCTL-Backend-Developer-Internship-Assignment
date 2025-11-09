// worker.js
import process from 'process';
import db from './db.js';

console.log(`Worker PID: ${process.pid} started and ready to poll.`);

let shuttingDown = false;
let shutdownStartTime = null;

process.on('SIGTERM', () => {
  console.log(`Worker PID: ${process.pid} received SIGTERM - initiating graceful shutdown...`);
  if (!shuttingDown) {
    shuttingDown = true;
    shutdownStartTime = Date.now();
  }
});

process.on('SIGINT', () => {
  console.log(`Worker PID: ${process.pid} received SIGINT - initiating graceful shutdown...`);
  if (!shuttingDown) {
    shuttingDown = true;
    shutdownStartTime = Date.now();
  }
});

async function executeCommand(command) {
  console.log(`Worker PID: ${process.pid} executing: ${command}`);
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: 'pipe' });

    let output = '';
    child.stdout.on('data', (data) => { 
      const chunk = data.toString();
      output += chunk;
      console.log(`Worker PID: ${process.pid} stdout: ${chunk.trim()}`);
    });
    child.stderr.on('data', (data) => { 
      const chunk = data.toString();
      output += chunk;
      console.log(`Worker PID: ${process.pid} stderr: ${chunk.trim()}`);
    });

    child.on('close', (code) => {
      console.log(`Worker PID: ${process.pid} command finished with code ${code}`);
      resolve({ code, output: output.trim() || 'No output' });
    });

    child.on('error', (err) => {
      console.log(`Worker PID: ${process.pid} spawn error: ${err.message}`);
      reject(err);
    });
  });
}

async function runWorker() {
  while (true) {
    if (shuttingDown) {
      if (!shutdownStartTime) shutdownStartTime = Date.now();
      const shutdownElapsed = Date.now() - shutdownStartTime;
      if (shutdownElapsed > 2000) {
        console.log(`Worker PID: ${process.pid} shutdown timeout - force exiting.`);
        process.exit(0);
      }
      console.log(`Worker PID: ${process.pid} shutting down (elapsed: ${shutdownElapsed / 1000}s) - waiting 1s...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    try {
      console.log(`Worker PID: ${process.pid} starting poll at ${new Date().toISOString()}`);
      const now = new Date().toISOString();
      const jobId = await db.acquireJob(now);
      console.log(`Worker PID: ${process.pid} poll result: ${jobId ? `Acquired job ${jobId}` : 'No job available'}`);

      if (!jobId) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      const job = await db.getJob(jobId);
      if (!job) {
        console.log(`Worker PID: ${process.pid} Job ${jobId} not found after acquire - skipping.`);
        continue;
      }

      console.log(`Worker PID: ${process.pid} fetched job details: attempts=${job.attempts}, max_retries=${job.max_retries}`);

      await db.updateJob(jobId, { state: 'processing' });
      console.log(`Worker PID: ${process.pid} marked job ${jobId} as processing`);

      try {
        const { code, output } = await executeCommand(job.command);
        const success = code === 0;
        const newAttempts = job.attempts + 1;
        const base = parseInt(await db.getConfig('backoff_base') || '2');

        if (success) {
          await db.updateJob(jobId, { state: 'completed' });
          console.log(`Worker PID: ${process.pid} SUCCESS: Job ${jobId} completed. Output: ${output}`);
        } else {
          console.log(`Worker PID: ${process.pid} FAILURE: Job ${jobId} failed (attempt ${newAttempts}). Output: ${output}`);
          if (newAttempts > job.max_retries) {
            await db.updateJob(jobId, { state: 'dead' });
            console.log(`Worker PID: ${process.pid} FINAL FAIL: Job ${jobId} to DLQ after ${newAttempts} attempts`);
          } else {
            const delaySeconds = Math.pow(base, newAttempts);
            const nextAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
            await db.updateJob(jobId, { 
              state: 'failed', 
              attempts: newAttempts, 
              next_attempt_at: nextAttempt 
            });
            console.log(`Worker PID: ${process.pid} RETRY: Job ${jobId} scheduled for ${delaySeconds}s later (${nextAttempt})`);
          }
        }
      } catch (execErr) {
        console.error(`Worker PID: ${process.pid} EXEC ERROR on ${jobId}: ${execErr.message}`);
        const newAttempts = job.attempts + 1;
        const base = parseInt(await db.getConfig('backoff_base') || '2');
        if (newAttempts > job.max_retries) {
          await db.updateJob(jobId, { state: 'dead' });
          console.log(`Worker PID: ${process.pid} EXEC FINAL FAIL: ${jobId} to DLQ (error)`);
        } else {
          const delaySeconds = Math.pow(base, newAttempts);
          const nextAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
          await db.updateJob(jobId, { 
            state: 'failed', 
            attempts: newAttempts, 
            next_attempt_at: nextAttempt 
          });
          console.log(`Worker PID: ${process.pid} EXEC RETRY: ${jobId} in ${delaySeconds}s (error)`);
        }
      }

      console.log(`Worker PID: ${process.pid} finished job ${jobId} - back to polling`);

    } catch (err) {
      console.error(`Worker PID: ${process.pid} CRITICAL LOOP ERROR: ${err.message}`);
      console.log(`Worker PID: ${process.pid} backing off 5s before retry...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

runWorker().catch((err) => {
  console.error(`Worker PID: ${process.pid} CRASHED: ${err.message}`);
  process.exit(1);
});