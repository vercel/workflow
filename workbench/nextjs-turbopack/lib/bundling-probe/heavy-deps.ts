// Heavy SDKs a realistic app's steps import at module scope. Constructing the
// clients needs no network.
import { S3Client } from '@aws-sdk/client-s3';
import { WebClient } from '@slack/web-api';
import OpenAI from 'openai';
import Stripe from 'stripe';

export function makeClients() {
  const s3 = new S3Client({ region: 'us-east-1' });
  const slack = new WebClient('xoxb-probe');
  const openai = new OpenAI({ apiKey: 'sk-probe' });
  const stripe = new Stripe('sk_test_probe');
  return [s3, slack, openai, stripe].map((c) => c.constructor.name);
}
