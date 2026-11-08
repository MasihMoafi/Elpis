// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/fixtures/deployment.ts.
import { testDeployment as sourceDeployment } from "../infra/fixtures.mts";
import { machineOf, type Deployment } from "../deployment.mts";
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...sourceDeployment(),
  ...machineOf("/tmp/mother-test"),
  ...overrides,
});
