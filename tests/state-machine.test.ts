import { describe, expect, it } from 'vitest';
import { JobStateMachine } from '@shorts/core';

describe('JobStateMachine', () => {
  it('allows the forward production path', () => {
    const path = [
      'CREATED', 'SELECTING_TOPIC', 'RESEARCHING', 'SCRIPTING', 'SYNTHESIZING_VOICE', 'BUILDING_TIMELINE',
      'SOURCING_MEDIA', 'RENDERING', 'QA', 'AWAITING_FINAL_APPROVAL', 'READY_TO_PUBLISH', 'PUBLISHING', 'PUBLISHED',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) expect(JobStateMachine.canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('rejects skipping stages, publishing from QA, and leaving terminal states', () => {
    expect(JobStateMachine.canTransition('CREATED', 'PUBLISHED')).toBe(false);
    expect(JobStateMachine.canTransition('QA', 'PUBLISHING')).toBe(false);
    expect(JobStateMachine.canTransition('AWAITING_FINAL_APPROVAL', 'PUBLISHING')).toBe(false);
    expect(JobStateMachine.canTransition('PUBLISHED', 'FAILED')).toBe(false);
    expect(JobStateMachine.canTransition('REJECTED', 'RESEARCHING')).toBe(false);
  });

  it('throws on illegal transitions instead of returning a flag', () => {
    expect(() => JobStateMachine.assertTransition('SCRIPTING', 'PUBLISHED')).toThrow(/Illegal job state transition/);
  });

  it('any working state may fail', () => {
    expect(JobStateMachine.canTransition('RENDERING', 'FAILED')).toBe(true);
    expect(JobStateMachine.canTransition('AWAITING_SCRIPT_APPROVAL', 'FAILED')).toBe(true);
  });

  it('resume is limited to the failed stage or earlier, and never into PUBLISHING', () => {
    expect(JobStateMachine.canResume('RENDERING', 'RENDERING')).toBe(true);
    expect(JobStateMachine.canResume('RENDERING', 'SCRIPTING')).toBe(true);
    expect(JobStateMachine.canResume('RENDERING', 'QA')).toBe(false);
    expect(JobStateMachine.canResume('PUBLISHING', 'PUBLISHING')).toBe(false);
    expect(JobStateMachine.canResume('PUBLISHING', 'QA')).toBe(false);
  });
});
