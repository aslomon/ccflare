import { installPricingFixture } from "./pricing";

installPricingFixture();
await import("../../../../packages/proxy/src/post-processor.worker");
