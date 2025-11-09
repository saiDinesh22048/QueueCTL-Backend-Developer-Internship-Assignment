import { Command } from 'commander';
import db from './db.js';
import process from 'process';

const program = new Command();
program.name('queuectl').description('CLI-based background job queue system').version('1.0.0');

program
  .command('enqueue')
  .description('Add a new job to the queue')
  .argument('<json>', 'Job JSON')
  .action(async (jsonStr) => {
    try {
      const jobData = JSON.parse(jsonStr);
      const id = await db.enqueueJob(jobData);
      console.log(`Enqueued job ${id}`);
    } catch (err) {
      console.error('Enqueue error:', err.message);
      process.exit(1);
    }
  });

const workerCmd = program.command('worker').description('Worker management');

workerCmd
  .command('start')
  .description('Start one or more workers')
  .option('-c, --count <number>', 'Number of workers', '1')
  .action(async (options) => {
    const count = parseInt(options.count);
    try {
      const pids = await db.startWorkers(count);
      console.log(`Started ${count} workers with PIDs: ${pids.join(', ')}`);
      process.on('SIGINT', async () => {
        console.log('\nStopping workers...');
        await db.stopWorkers();
        process.exit(0);
      });
      
      await new Promise(() => {});
    } catch (err) {
      console.error('Start workers error:', err);
      process.exit(1);
    }
  });

workerCmd
  .command('stop')
  .description('Stop running workers gracefully')
  .action(async () => {
    try {
      await db.stopWorkers();
      console.log('Sent stop signal to workers');
    } catch (err) {
      console.error('Stop workers error:', err);
    }
  });

program
  .command('status')
  .description('Show summary of all job states & active workers')
  .action(async () => {
    try {
      const status = await db.getStatus();
      console.log('Queue Status:');
      console.table(status);
    } catch (err) {
      console.error('Status error:', err);
    }
  });

program
  .command('list')
  .description('List jobs by state')
  .option('--state <state>', 'Filter by state')
  .action(async (options) => {
    try {
      const jobs = await db.listJobs(options.state);
      console.log(`Jobs (${options.state || 'all'}): ${jobs.length}`);
      if (jobs.length > 0) {
        console.table(jobs);
      }
    } catch (err) {
      console.error('List error:', err);
    }
  });

const dlqCmd = program.command('dlq').description('DLQ commands');

dlqCmd
  .command('list')
  .description('View DLQ jobs')
  .action(async () => {
    try {
      const jobs = await db.dlqList();
      console.log(`DLQ Jobs: ${jobs.length}`);
      if (jobs.length > 0) {
        console.table(jobs);
      }
    } catch (err) {
      console.error('DLQ list error:', err);
    }
  });

dlqCmd
  .command('retry')
  .description('Retry a DLQ job')
  .argument('<jobId>', 'Job ID')
  .action(async (jobId) => {
    try {
      await db.dlqRetry(jobId);
      console.log(`Retried job ${jobId} (moved back to pending)`);
    } catch (err) {
      console.error('Retry error:', err.message);
      process.exit(1);
    }
  });

const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('set')
  .description('Set config value')
  .argument('<key>', 'Config key (e.g., max-retries, backoff_base)')
  .argument('<value>', 'Config value')
  .action(async (key, value) => {
    try {
      await db.setConfig(key, value);
      console.log(`Set ${key} = ${value}`);
    } catch (err) {
      console.error('Config set error:', err);
    }
  });

program.parse(process.argv);

if (program.args.length === 0) {
  program.help();
}