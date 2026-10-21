import {
  SQSClient, CreateQueueCommand, GetQueueAttributesCommand,
  SendMessageCommand, ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";

const sqs = new SQSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = Date.now();

const dlq = await sqs.send(new CreateQueueCommand({
  QueueName: `spike-dlq-${id}.fifo`,
  Attributes: { FifoQueue: "true" },
}));
const dlqArn = (await sqs.send(new GetQueueAttributesCommand({
  QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"],
}))).Attributes!.QueueArn;

const main = await sqs.send(new CreateQueueCommand({
  QueueName: `spike-main-${id}.fifo`,
  Attributes: {
    FifoQueue: "true",
    VisibilityTimeout: "1",
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 2 }),
  },
}));

const send = () => sqs.send(new SendMessageCommand({
  QueueUrl: main.QueueUrl,
  MessageBody: "ola",
  MessageGroupId: "wallet-1",
  MessageDeduplicationId: "msg-1",
}));
await send();
await send(); // duplicada de propósito

const receive = async (url: string | undefined, label: string) => {
  const r = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
  }));
  console.log(label, "->", r.Messages?.length ?? 0, "mensagem(ns)");
};

await receive(main.QueueUrl, "recebimento 1 (esperado: 1, dedup)");
await sleep(1500);
await receive(main.QueueUrl, "recebimento 2 (esperado: 1)");
await sleep(1500);
await receive(main.QueueUrl, "recebimento 3 (esperado: 0, foi pra DLQ)");
await receive(dlq.QueueUrl, "DLQ (esperado: 1)");
