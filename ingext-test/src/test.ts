import { S3NotificationTask } from './S3NotificationTask';
import { TaskContext } from './types';

async function runTest() {
  // 1. MOCK INPUTS
  // Change these values to match your actual AWS environment
  const inputs = {
    bucketName: "demo-cloudtrail-ingext", // MUST EXIST ALREADY
    region: "us-east-1",
    remoteProfile: "demo",            // Change if using cross-account
    prefix: "AWSLogs/",                     // Optional
    queueName: ""    // Optional (will default if omitted)
  };

  const context: TaskContext = {
    platform: 'EKS',
    userInputs: inputs
  };

  const task = new S3NotificationTask();

  console.log("=== STARTING TEST ===");
  
  // 2. VALIDATE
  const isValid = await task.validate(context);
  if (!isValid) {
    console.error("Validation failed. Check scripts and inputs.");
    process.exit(1);
  }

  // 3. EXECUTE
  try {
    const result = await task.execute(context);
    console.log("\n=== SUCCESS ===");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("\n=== FAILED ===");
    console.error(error);
  }
}

runTest();
