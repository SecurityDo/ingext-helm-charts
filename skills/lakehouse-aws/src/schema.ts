import { z } from "zod";

const lowerAlnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const PreflightInputSchema = z.object({
  awsProfile: z.string().default("default"),
  awsRegion: z.string().default("us-east-2"),
  clusterName: z.string().default("ingext-lakehouse").transform(lowerAlnum),
  s3Bucket: z.string().optional(), // if omitted, we template it after we know accountId
  rootDomain: z.string().min(3, "rootDomain is required (e.g., example.com or ingext.io)"),
  siteDomain: z.string().optional(), // if omitted, will be constructed as lakehouse.k8.{rootDomain}
  certArn: z.string().optional(), // Auto-discovered from ACM if not provided
  namespace: z.string().default("ingext").transform(lowerAlnum),
  nodeType: z.string().default("t3.large"),
  nodeCount: z.union([z.string(), z.number()]).default(2).transform((v) => Number(v)),

  readiness: z
    .object({
      hasBilling: z.boolean().default(true),
      hasAdmin: z.boolean().default(true),
      hasDns: z.boolean().default(true),
    })
    .default({ hasBilling: true, hasAdmin: true, hasDns: true }),

  outputEnvPath: z.string().default("./lakehouse-aws.env"),
  writeEnvFile: z.boolean().default(true),
  overwriteEnv: z.boolean().default(false),
  dnsCheck: z.boolean().default(true),
  approve: z.boolean().optional(), // If true, proceed with installation after preflight
  execMode: z.enum(["docker", "local"]).default("local"), // Execution mode: docker or local
});

export type PreflightInput = z.infer<typeof PreflightInputSchema>;