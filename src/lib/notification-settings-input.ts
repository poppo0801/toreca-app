import { z } from "zod";

/** 通知設定の入力検証（選択肢は固定。任意の数値を受け付けない）。 */
export const DEADLINE_OFFSET_OPTIONS = [1440, 720, 240, 120, 60, 30, 15, 5] as const;
export const RESULT_REMINDER_OPTIONS = [1, 3, 6, 12, 24, 48] as const;
export const PROCEDURE_LEAD_OPTIONS = [72, 48, 24, 12, 6, 3, 1] as const;

const subset = <T extends readonly number[]>(options: T, max: number) =>
  z
    .array(z.number().int())
    .max(max)
    .refine((a) => a.every((v) => options.includes(v)), "選択肢にない値です")
    .refine((a) => new Set(a).size === a.length, "重複があります");

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  morningTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "時刻の形式が正しくありません"),
  deadlineOffsetsMin: subset(DEADLINE_OFFSET_OPTIONS, 6),
  resultEnabled: z.boolean(),
  resultReminderHours: subset(RESULT_REMINDER_OPTIONS, 4),
  procedureEnabled: z.boolean(),
  procedureLeadHours: subset(PROCEDURE_LEAD_OPTIONS, 4),
  dateOnlyPolicy: z.enum(["morning_of", "none"]),
  eligibilityExpiryDays: z.number().int().min(0).max(90),
});
