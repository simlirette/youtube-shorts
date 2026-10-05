import { WorkflowState } from '@shorts/schemas';
import { logger } from './logger.js';

export interface StateTransitionResult {
  success: boolean;
  previousState: WorkflowState;
  newState: WorkflowState;
  error?: string;
}

// Deterministic state transition graph
const VALID_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  DISCOVERED: ['SCORED', 'REJECTED'],
  SCORED: ['RESEARCHING', 'REJECTED'],
  RESEARCHING: ['RESEARCHED', 'REJECTED'],
  RESEARCHED: ['STORY_READY', 'REJECTED'],
  STORY_READY: ['SCRIPTING', 'REJECTED'],
  SCRIPTING: ['SCRIPT_REVIEW', 'REJECTED'],
  SCRIPT_REVIEW: ['SCRIPT_APPROVED', 'SCRIPTING', 'REJECTED'], // Loopback for script revisions
  SCRIPT_APPROVED: ['ASSET_PREPARATION', 'REJECTED'],
  ASSET_PREPARATION: ['RENDERING', 'REJECTED'],
  RENDERING: ['RENDERED', 'REJECTED'],
  RENDERED: ['QA', 'REJECTED'],
  QA: ['QA_PASSED', 'QA_FAILED'],
  QA_FAILED: ['ASSET_PREPARATION', 'SCRIPTING', 'REJECTED'], // Re-route to fix visual or script
  QA_PASSED: ['APPROVED', 'REJECTED'],
  APPROVED: ['UPLOADING', 'REJECTED'],
  UPLOADING: ['PUBLISHED', 'APPROVED'], // Loopback on upload retry
  PUBLISHED: ['ANALYZING'],
  ANALYZING: [],
  REJECTED: [],
};

export class ContentStateMachine {
  /**
   * Evaluates whether a transition from currentState to targetState is valid.
   */
  static canTransition(current: WorkflowState, next: WorkflowState): boolean {
    const allowed = VALID_TRANSITIONS[current] || [];
    return allowed.includes(next);
  }

  /**
   * Executes a validated transition.
   */
  static transition(
    current: WorkflowState,
    next: WorkflowState,
    context?: { topicId?: string; scriptId?: string; reason?: string }
  ): StateTransitionResult {
    if (!this.canTransition(current, next)) {
      const err = `Invalid workflow transition from ${current} to ${next}. Allowed: [${(VALID_TRANSITIONS[current] || []).join(', ')}]`;
      logger.error(err, undefined, { stage: 'STATE_MACHINE', ...context });
      return {
        success: false,
        previousState: current,
        newState: current,
        error: err,
      };
    }

    logger.info(`State transitioned: ${current} ──> ${next}`, {
      stage: 'STATE_MACHINE',
      previousState: current,
      newState: next,
      ...context,
    });

    return {
      success: true,
      previousState: current,
      newState: next,
    };
  }
}
