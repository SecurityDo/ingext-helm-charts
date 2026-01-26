export interface TaskContext {
  platform: 'EKS' | 'AKS' | 'GCP';
  userInputs: Record<string, any>;
}

export interface ResourceRecord {
  id: string;
  type: string;
  details: any;
  timestamp: number;
}

export interface ITask {
  name: string;
  description: string;
  validate(ctx: TaskContext): Promise<boolean>;
  execute(ctx: TaskContext): Promise<ResourceRecord>;
  rollback(record: ResourceRecord, ctx: TaskContext): Promise<void>;
}
