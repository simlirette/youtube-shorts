import { describe, it, expect } from 'vitest';
import { ContentStateMachine } from '@shorts/core';

describe('ContentStateMachine', () => {
  it('allows valid sequential transitions', () => {
    expect(ContentStateMachine.canTransition('DISCOVERED', 'SCORED')).toBe(true);
    expect(ContentStateMachine.canTransition('SCORED', 'RESEARCHING')).toBe(true);
    expect(ContentStateMachine.canTransition('RESEARCHING', 'RESEARCHED')).toBe(true);
    expect(ContentStateMachine.canTransition('RESEARCHED', 'STORY_READY')).toBe(true);
    expect(ContentStateMachine.canTransition('STORY_READY', 'SCRIPTING')).toBe(true);
    expect(ContentStateMachine.canTransition('SCRIPTING', 'SCRIPT_REVIEW')).toBe(true);
    expect(ContentStateMachine.canTransition('SCRIPT_REVIEW', 'SCRIPT_APPROVED')).toBe(true);
    expect(ContentStateMachine.canTransition('SCRIPT_APPROVED', 'ASSET_PREPARATION')).toBe(true);
    expect(ContentStateMachine.canTransition('ASSET_PREPARATION', 'RENDERING')).toBe(true);
    expect(ContentStateMachine.canTransition('RENDERING', 'RENDERED')).toBe(true);
    expect(ContentStateMachine.canTransition('RENDERED', 'QA')).toBe(true);
    expect(ContentStateMachine.canTransition('QA', 'QA_PASSED')).toBe(true);
    expect(ContentStateMachine.canTransition('QA_PASSED', 'APPROVED')).toBe(true);
    expect(ContentStateMachine.canTransition('APPROVED', 'UPLOADING')).toBe(true);
    expect(ContentStateMachine.canTransition('UPLOADING', 'PUBLISHED')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    // Skipping mandatory stages
    expect(ContentStateMachine.canTransition('DISCOVERED', 'PUBLISHED')).toBe(false);
    expect(ContentStateMachine.canTransition('DISCOVERED', 'RENDERING')).toBe(false);
    expect(ContentStateMachine.canTransition('SCRIPTING', 'PUBLISHED')).toBe(false);
    expect(ContentStateMachine.canTransition('PUBLISHED', 'DISCOVERED')).toBe(false);
  });

  it('executes transition and returns updated state', () => {
    const res = ContentStateMachine.transition('DISCOVERED', 'SCORED');
    expect(res.success).toBe(true);
    expect(res.previousState).toBe('DISCOVERED');
    expect(res.newState).toBe('SCORED');
  });

  it('fails on illegal transition and leaves state untouched', () => {
    const res = ContentStateMachine.transition('DISCOVERED', 'PUBLISHED');
    expect(res.success).toBe(false);
    expect(res.newState).toBe('DISCOVERED');
    expect(res.error).toBeDefined();
  });
});
