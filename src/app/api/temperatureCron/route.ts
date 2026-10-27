import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
import { eq, sql } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import { setHeatingLevel, turnOnSide, turnOffSide } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";

export const runtime = "nodejs";

// After wake-up, the side is turned off automatically only until this many minutes past wake-up.
// Later in the day the cron no longer switches the bed off (e.g. for naps).
const TURN_OFF_WINDOW_MINUTES = 90;

// If a side is found running outside its sleep schedule (e.g. a nap started in the Eight Sleep app),
// it is switched off once it has been seen running for this many minutes.
// The shutoff happens on the first cron run after the limit, so expect up to ~15 minutes extra.
const NAP_LIMIT_MINUTES = 120;

// The nap timer lives in its own small table. It is deliberately NOT prefixed "8slp_" and NOT in
// schema.ts, so `drizzle-kit push` (tablesFilter "8slp_*") never sees or drops it. It is created on
// first use, and every use is wrapped so a failure here can never break the normal schedule.
let napTableReady = false;

async function ensureNapTable(): Promise<void> {
  if (napTableReady) return;
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS nosub_nap_timers (email varchar(255) PRIMARY KEY, heating_since timestamptz NOT NULL)`,
  );
  napTableReady = true;
}

async function getNapStart(email: string): Promise<Date | null> {
  await ensureNapTable();
  const result: unknown = await db.execute(
    sql`SELECT heating_since FROM nosub_nap_timers WHERE email = ${email}`,
  );
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  const value = rows[0]?.heating_since;
  if (value === undefined || value === null) return null;
  const parsed = new Date(value as string | Date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

async function setNapStart(email: string, since: Date): Promise<void> {
  await ensureNapTable();
  await db.execute(
    sql`INSERT INTO nosub_nap_timers (email, heating_since) VALUES (${email}, ${since.toISOString()}::timestamptz) ON CONFLICT (email) DO UPDATE SET heating_since = EXCLUDED.heating_since`,
  );
}

async function clearNapStart(email: string): Promise<void> {
  await ensureNapTable();
  await db.execute(sql`DELETE FROM nosub_nap_timers WHERE email = ${email}`);
}

type NapAction = "clear" | "start" | "wait" | "turn-off";

// Pure decision logic (no I/O) so it is easy to reason about.
function decideNapAction(
  heatingOutsideSchedule: boolean,
  since: Date | null,
  now: Date,
  limitMinutes: number,
): NapAction {
  if (!heatingOutsideSchedule) return "clear";
  if (since === null || since.getTime() > now.getTime()) return "start";
  return now.getTime() - since.getTime() >= limitMinutes * 60 * 1000 ? "turn-off" : "wait";
}

async function applyNapGuard(
  token: Token,
  email: string,
  eightUserId: string,
  heatingOutsideSchedule: boolean,
  now: Date,
  testMode?: TestMode,
): Promise<void> {
  if (testMode?.enabled) {
    console.log(`[TEST MODE] Nap guard skipped for user ${email}`);
    return;
  }
  try {
    const since = heatingOutsideSchedule ? await getNapStart(email) : null;
    const action = decideNapAction(heatingOutsideSchedule, since, now, NAP_LIMIT_MINUTES);
    if (action === "clear") {
      await clearNapStart(email);
    } else if (action === "start") {
      await setNapStart(email, now);
      console.log(`Nap guard: bed running outside its schedule for user ${email}; timer started (${NAP_LIMIT_MINUTES} min limit)`);
    } else if (action === "wait") {
      const elapsed = since ? Math.round((now.getTime() - since.getTime()) / 60000) : 0;
      console.log(`Nap guard: bed running outside its schedule for ${elapsed} min for user ${email}; limit is ${NAP_LIMIT_MINUTES} min`);
    } else {
      await retryApiCall(() => turnOffSide(token, eightUserId));
      await clearNapStart(email);
      console.log(`Nap guard: ${NAP_LIMIT_MINUTES} min limit reached, heating turned off for user ${email}`);
    }
  } catch (error) {
    console.error(`Nap guard error for user ${email}:`, error instanceof Error ? error.message : String(error));
  }
}

function createDateWithTime(baseDate: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  if (hours === undefined || minutes === undefined || isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time string: ${timeString}`);
  }
  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isWithinTimeRange(current: Date, target: Date, rangeMinutes: number): boolean {
  const diffMs = Math.abs(current.getTime() - target.getTime());
  return diffMs <= rangeMinutes * 60 * 1000;
}

async function retryApiCall<T>(apiCall: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("This should never happen due to the for loop, but TypeScript doesn't know that");
}

interface SleepCycle {
  preHeatingTime: Date;
  bedTime: Date;
  midStageTime: Date;
  finalStageTime: Date;
  wakeupTime: Date;
}

function createSleepCycle(baseDate: Date, bedTimeStr: string, wakeupTimeStr: string): SleepCycle {
  const preHeatingTime = createDateWithTime(baseDate, bedTimeStr);
  preHeatingTime.setHours(preHeatingTime.getHours() - 1); // Set pre-heating to 1 hour before bedtime
  
  const bedTime = createDateWithTime(baseDate, bedTimeStr);
  let wakeupTime = createDateWithTime(baseDate, wakeupTimeStr);
  
  // Adjust wakeupTime if it's before bedTime (i.e., it's on the next day)
  if (wakeupTime <= bedTime) {
    wakeupTime = addDays(wakeupTime, 1);
  }
  
  const midStageTime = new Date(bedTime.getTime() + 60 * 60 * 1000);
  const finalStageTime = new Date(wakeupTime.getTime() - 2 * 60 * 60 * 1000);
  
  return { preHeatingTime, bedTime, midStageTime, finalStageTime, wakeupTime };
}

function adjustTimeToCurrentCycle(cycleStart: Date, currentTime: Date, timeInCycle: Date): Date {
  let adjustedTime = new Date(timeInCycle);
  
  // If the time in the cycle is before the cycle start, it means it's on the next day
  if (timeInCycle < cycleStart) {
    adjustedTime = addDays(adjustedTime, 1);
  }
  
  // If the adjusted time is in the future relative to the current time, move it back by one day
  if (adjustedTime > currentTime && adjustedTime.getTime() - currentTime.getTime() > 12 * 60 * 60 * 1000) {
    adjustedTime = addDays(adjustedTime, -1);
  }
  
  return adjustedTime;
}

interface TestMode {
  enabled: boolean;
  currentTime: Date;
}

export async function adjustTemperature(testMode?: TestMode): Promise<void> {
  try {
    const profiles = await db
      .select()
      .from(userTemperatureProfile)
      .innerJoin(users, eq(userTemperatureProfile.email, users.email));

    for (const profile of profiles) {
      try {
        let token: Token = {
          eightAccessToken: profile.users.eightAccessToken,
          eightRefreshToken: profile.users.eightRefreshToken,
          eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
          eightUserId: profile.users.eightUserId,
        };

        const now = testMode?.enabled ? testMode.currentTime : new Date();

        if (!testMode?.enabled && now.getTime() > token.eightExpiresAtPosix) {
          token = await obtainFreshAccessToken(
            token.eightRefreshToken,
            token.eightUserId,
          );
          await db
            .update(users)
            .set({
              eightAccessToken: token.eightAccessToken,
              eightRefreshToken: token.eightRefreshToken,
              eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
            })
            .where(eq(users.email, profile.users.email));
        }

        const userTemperatureProfile = profile.userTemperatureProfiles;
        const userNow = new Date(now.toLocaleString("en-US", { timeZone: userTemperatureProfile.timezoneTZ }));

        // Create the sleep cycle based on the user's bed time and wake-up time
        const sleepCycle = createSleepCycle(userNow, userTemperatureProfile.bedTime, userTemperatureProfile.wakeupTime);

        // Adjust all times in the cycle to the current day
        const cycleStart = sleepCycle.preHeatingTime;
        const adjustedCycle: SleepCycle = {
          preHeatingTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.preHeatingTime),
          bedTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.bedTime),
          midStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.midStageTime),
          finalStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.finalStageTime),
          wakeupTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.wakeupTime),
        };

        let heatingStatus;
        if (testMode?.enabled) {
          heatingStatus = { isHeating: false, heatingLevel: 0 }; // Mock heating status for test mode
          console.log(`[TEST MODE] Current time set to: ${userNow.toISOString()}`);
        } else {
          heatingStatus = await retryApiCall(() => getCurrentHeatingStatus(token));
        }

        console.log(`Current heating status for user ${profile.users.email}:`, JSON.stringify(heatingStatus));
        console.log(`User's current time: ${userNow.toISOString()} for user ${profile.users.email}`);
        console.log(`Adjusted times for user ${profile.users.email}:`);
        console.log(`Pre-heating: ${adjustedCycle.preHeatingTime.toISOString()}`);
        console.log(`Bed time: ${adjustedCycle.bedTime.toISOString()}`);
        console.log(`Mid stage: ${adjustedCycle.midStageTime.toISOString()}`);
        console.log(`Final stage: ${adjustedCycle.finalStageTime.toISOString()}`);
        console.log(`Wake-up: ${adjustedCycle.wakeupTime.toISOString()}`);

        const isNearPreHeating = isWithinTimeRange(userNow, adjustedCycle.preHeatingTime, 15);
        const isNearBedTime = isWithinTimeRange(userNow, adjustedCycle.bedTime, 15);
        const isNearMidStage = isWithinTimeRange(userNow, adjustedCycle.midStageTime, 15);
        const isNearFinalStage = isWithinTimeRange(userNow, adjustedCycle.finalStageTime, 15);
        const isNearWakeup = isWithinTimeRange(userNow, adjustedCycle.wakeupTime, 15);

        // Determine current sleep stage
        let currentSleepStage = "outside sleep cycle";
        if (userNow >= adjustedCycle.preHeatingTime && userNow < adjustedCycle.bedTime) {
          currentSleepStage = "pre-heating";
        } else if (userNow >= adjustedCycle.bedTime && userNow < adjustedCycle.midStageTime) {
          currentSleepStage = "initial";
        } else if (userNow >= adjustedCycle.midStageTime && userNow < adjustedCycle.finalStageTime) {
          currentSleepStage = "mid";
        } else if (userNow >= adjustedCycle.finalStageTime && userNow < adjustedCycle.wakeupTime) {
          currentSleepStage = "final";
        }

        console.log(`Current sleep stage for user ${profile.users.email}: ${currentSleepStage}`);

        // True when this run already handled the bed as part of the normal schedule.
        let actedOnSchedule = false;

        if (isNearPreHeating || isNearBedTime || isNearMidStage || isNearFinalStage || isNearWakeup) {
          actedOnSchedule = true;
          let targetLevel: number;
          let sleepStage: string;

          if (isNearPreHeating || (isNearBedTime && userNow < adjustedCycle.bedTime)) {
            targetLevel = userTemperatureProfile.initialSleepLevel;
            sleepStage = "pre-heating";
          } else if (isNearBedTime || (isNearMidStage && userNow < adjustedCycle.midStageTime)) {
            targetLevel = userTemperatureProfile.initialSleepLevel;
            sleepStage = "initial";
          } else if (isNearMidStage || (isNearFinalStage && userNow < adjustedCycle.finalStageTime)) {
            targetLevel = userTemperatureProfile.midStageSleepLevel;
            sleepStage = "mid";
          } else {
            targetLevel = userTemperatureProfile.finalSleepLevel;
            sleepStage = "final";
          }

          console.log(`Adjusting temperature for ${sleepStage} stage for user ${profile.users.email}`);

          if (!heatingStatus.isHeating) {
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would turn on heating for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => turnOnSide(token, profile.users.eightUserId));
              console.log(`Heating turned on for user ${profile.users.email}`);
            }
          }
          if (heatingStatus.heatingLevel !== targetLevel) {
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would set heating level to ${targetLevel} for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => setHeatingLevel(token, profile.users.eightUserId, targetLevel));
              console.log(`Heating level set to ${targetLevel} for user ${profile.users.email}`);
            }
          }
        } else if (
          heatingStatus.isHeating &&
          userNow > adjustedCycle.wakeupTime &&
          !isWithinTimeRange(userNow, adjustedCycle.wakeupTime, 15) &&
          userNow.getTime() - adjustedCycle.wakeupTime.getTime() <= TURN_OFF_WINDOW_MINUTES * 60 * 1000
        ) {
          // Only turn off heating in the window after wake-up (15 min to TURN_OFF_WINDOW_MINUTES past it),
          // so a daytime nap started in the Eight Sleep app is left alone (the nap guard below limits it).
          actedOnSchedule = true;
          if (testMode?.enabled) {
            console.log(`[TEST MODE] Would turn off heating for user ${profile.users.email}`);
          } else {
            await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
            console.log(`Heating turned off for user ${profile.users.email}`);
          }
        } else {
          console.log(`No temperature change needed for user ${profile.users.email}`);
        }

        // Nap guard: a bed that keeps running outside its sleep schedule is switched off after NAP_LIMIT_MINUTES.
        const heatingOutsideSchedule =
          !actedOnSchedule && heatingStatus.isHeating && currentSleepStage === "outside sleep cycle";
        await applyNapGuard(
          token,
          profile.users.email,
          profile.users.eightUserId,
          heatingOutsideSchedule,
          now,
          testMode,
        );

        console.log(`Successfully completed temperature adjustment check for user ${profile.users.email}`);
      } catch (error) {
        console.error(`Error adjusting temperature for user ${profile.users.email}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.error("Error fetching user profiles:", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  } else {
    try {
      const testTimeParam = request.nextUrl.searchParams.get("testTime");
      if (testTimeParam) {
        const testTime = new Date(Number(testTimeParam)* 1000);
        if (isNaN(testTime.getTime())) {
          throw new Error("Invalid testTime parameter");
        }
        console.log(`[TEST MODE] Running temperature adjustment cron job with test time: ${testTime.toISOString()}`);
        await adjustTemperature({ enabled: true, currentTime: testTime });
      } else {
        await adjustTemperature();
      }
      return Response.json({ success: true });
    } catch (error) {
      console.error("Error in temperature adjustment cron job:", error instanceof Error ? error.message : String(error));
      return new Response("Internal server error", { status: 500 });
    }
  }
}