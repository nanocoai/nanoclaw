import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { AwsClient } from 'aws4fetch';

import type { SignedFetch } from './store.js';

type RoleCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
type CredentialProvider = () => Promise<RoleCredentials>;
type ClientFactory = (credentials: RoleCredentials) => SignedFetch;

export function roleBackedS3Fetch(
  region: string,
  provide: CredentialProvider = defaultProvider({ clientConfig: { region } }),
  create: ClientFactory = (credentials) =>
    new AwsClient({ service: 's3', region, ...credentials }),
): SignedFetch {
  return {
    async fetch(input, init) {
      return (await create(await provide()).fetch(input, init));
    },
  };
}
