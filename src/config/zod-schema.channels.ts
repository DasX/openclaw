// Defines channel-related Zod schema fragments for config parsing.
import { z } from "zod";

export const ChannelHealthMonitorSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();
