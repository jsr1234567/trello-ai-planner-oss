import { autoPlanTrelloTasks } from "./auto-plan.js";
import { reconcileDailyTrelloWorkflow } from "./google-tasks.js";
import { reconcilePlanningPipeline } from "./planning-pipeline.js";

// This is deliberately a once-daily commitment pass, separate from the
// five-minute completion/conflict sync. It first advances dated work through
// the Trello funnel, then commits only capacity-fitting Today and This Week
// cards to Calendar and Google Tasks for the coming seven-day planning window.
export async function runDailyPlanning({
  now = new Date(),
  reconcilePipeline = reconcilePlanningPipeline,
  autoPlan = autoPlanTrelloTasks,
  reconcileWorkflow = reconcileDailyTrelloWorkflow
} = {}) {
  const pipeline = await reconcilePipeline({ now });
  const plan = await autoPlan({ now });
  const workflow = await reconcileWorkflow({ now });
  return { pipeline, plan, workflow };
}
