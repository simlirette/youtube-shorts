import type { JobState } from '@shorts/schemas';
import { InternalError } from './errors.js';

/** Ordered production stages. Earlier index = earlier stage. Used for resume-from validation. */
export const STAGE_ORDER: JobState[] = [
  'CREATED',
  'SELECTING_TOPIC',
  'AWAITING_IDEA_APPROVAL',
  'RESEARCHING',
  'SCRIPTING',
  'AWAITING_SCRIPT_APPROVAL',
  'SYNTHESIZING_VOICE',
  'BUILDING_TIMELINE',
  'SOURCING_MEDIA',
  'RENDERING',
  'QA',
  'AWAITING_FINAL_APPROVAL',
  'READY_TO_PUBLISH',
  'PUBLISHING',
  'PUBLISHED',
];

/** Stages that perform work (as opposed to waiting for a human or being terminal). */
export const WORK_STAGES: JobState[] = [
  'SELECTING_TOPIC',
  'RESEARCHING',
  'SCRIPTING',
  'SYNTHESIZING_VOICE',
  'BUILDING_TIMELINE',
  'SOURCING_MEDIA',
  'RENDERING',
  'QA',
  'PUBLISHING',
];

export const AWAITING_STATES: JobState[] = ['AWAITING_IDEA_APPROVAL', 'AWAITING_SCRIPT_APPROVAL', 'AWAITING_FINAL_APPROVAL'];
export const TERMINAL_STATES: JobState[] = ['PUBLISHED', 'REJECTED'];

const FORWARD: Record<JobState, JobState[]> = {
  CREATED: ['SELECTING_TOPIC'],
  SELECTING_TOPIC: ['AWAITING_IDEA_APPROVAL', 'RESEARCHING'],
  AWAITING_IDEA_APPROVAL: ['RESEARCHING', 'REJECTED'],
  RESEARCHING: ['SCRIPTING'],
  SCRIPTING: ['AWAITING_SCRIPT_APPROVAL', 'SYNTHESIZING_VOICE'],
  AWAITING_SCRIPT_APPROVAL: ['SYNTHESIZING_VOICE', 'SCRIPTING', 'REJECTED'],
  SYNTHESIZING_VOICE: ['BUILDING_TIMELINE'],
  BUILDING_TIMELINE: ['SOURCING_MEDIA'],
  SOURCING_MEDIA: ['RENDERING'],
  RENDERING: ['QA'],
  QA: ['AWAITING_FINAL_APPROVAL', 'READY_TO_PUBLISH'],
  AWAITING_FINAL_APPROVAL: ['READY_TO_PUBLISH', 'REJECTED'],
  READY_TO_PUBLISH: ['PUBLISHING', 'REJECTED'],
  PUBLISHING: ['PUBLISHED'],
  PUBLISHED: [],
  REJECTED: [],
  FAILED: [],
};

export class JobStateMachine {
  static canTransition(from: JobState, to: JobState): boolean {
    if (to === 'FAILED') return !TERMINAL_STATES.includes(from) && from !== 'FAILED';
    return FORWARD[from].includes(to);
  }

  /** Throws on an illegal transition — callers cannot ignore the result. */
  static assertTransition(from: JobState, to: JobState): void {
    if (!this.canTransition(from, to)) {
      throw new InternalError(`Illegal job state transition ${from} -> ${to}. Allowed: [${FORWARD[from].join(', ')}${from !== 'FAILED' && !TERMINAL_STATES.includes(from) ? ', FAILED' : ''}]`);
    }
  }

  static stageIndex(state: JobState): number {
    return STAGE_ORDER.indexOf(state);
  }

  /**
   * A FAILED job may resume into the stage that failed or any earlier work stage.
   * PUBLISHING is excluded: a crash during upload needs manual reconciliation to avoid duplicates.
   */
  static canResume(failedStage: JobState | undefined, target: JobState): boolean {
    if (!failedStage) return false;
    if (!WORK_STAGES.includes(target) || target === 'PUBLISHING') return false;
    if (failedStage === 'PUBLISHING') return false;
    return this.stageIndex(target) <= this.stageIndex(failedStage) && this.stageIndex(target) >= 0;
  }
}
