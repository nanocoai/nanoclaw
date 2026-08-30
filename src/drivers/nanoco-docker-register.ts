import { DockerSessionDriver } from './docker-driver.js';
import { registerSessionDriver } from './driver-registry.js';
import { networkArgsForNanoCoSession } from '../gateway-providers/nanoco.js';

registerSessionDriver(
  'nanoco-docker',
  (policy) => new DockerSessionDriver({ ...policy, networkArgsFor: networkArgsForNanoCoSession }),
);
