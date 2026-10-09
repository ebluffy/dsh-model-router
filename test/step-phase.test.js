import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isEditTool,
  isInspectionTool,
  classifyStepPhase,
} from '../lib/step-phase.js'

test('tool helper recognizers classify tool names', () => {
  assert.equal(isInspectionTool('view_file'), true)
  assert.equal(isInspectionTool('read_file'), true)
  assert.equal(isInspectionTool('search_web'), true)
  assert.equal(isInspectionTool('list_dir'), true)
  assert.equal(isInspectionTool('replace_file_content'), false)

  assert.equal(isEditTool('replace_file_content'), true)
  assert.equal(isEditTool('write_to_file'), true)
  assert.equal(isEditTool('edit_file'), true)
  assert.equal(isEditTool('view_file'), false)
})

test('classifyStepPhase step 0 defers to base classifier', () => {
  const res = classifyStepPhase({ messages: [], payload: { step: 0 } })
  assert.equal(res.phase, 'initial')
  assert.equal(res.stepClass, null)
})

test('classifyStepPhase routes clean read tool results to cheap tier with low effort', () => {
  const messages = [
    { role: 'user', content: 'Refactor the backend' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'view_file', arguments: '{"AbsolutePath":"server.js"}' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', content: 'const a = 1;', isError: false },
      ],
    },
  ]

  const res = classifyStepPhase({ messages, payload: { step: 1 } })
  assert.equal(res.phase, 'inspection')
  assert.equal(res.stepClass, 'standard')
  assert.equal(res.suggestedTier, 'cheap')
  assert.equal(res.suggestedEffort, 'low')
  assert.equal(res.bypassHysteresis, true)
})

test('classifyStepPhase routes clean commands (npm run lint exit 0) to cheap tier', () => {
  const messages = [
    { role: 'user', content: 'Build project' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'run_command', arguments: 'npm run lint' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', content: 'Lint succeeded with 0 warnings.', isError: false },
      ],
    },
  ]

  const res = classifyStepPhase({ messages, payload: { step: 2 } })
  assert.equal(res.phase, 'inspection')
  assert.equal(res.suggestedTier, 'cheap')
  assert.equal(res.suggestedEffort, 'low')
})

test('classifyStepPhase escalates tool failure to strong tier with high effort', () => {
  const messages = [
    { role: 'user', content: 'Fix bug' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'run_command', arguments: 'npm test' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', content: 'TypeError: failed\n[exit code: 1]', isError: true },
      ],
    },
  ]

  const res = classifyStepPhase({ messages, payload: { step: 1 } })
  assert.equal(res.phase, 'debugging')
  assert.equal(res.stepClass, 'engineering')
  assert.equal(res.suggestedTier, 'strong')
  assert.equal(res.suggestedEffort, 'high')
  assert.equal(res.bypassHysteresis, false)
})

test('classifyStepPhase routes code edits to strong tier with high effort', () => {
  const messages = [
    { role: 'user', content: 'Refactor parser' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'replace_file_content', arguments: '{"TargetFile":"a.js"}' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', content: 'Successfully replaced content', isError: false },
      ],
    },
  ]

  const res = classifyStepPhase({ messages, payload: { step: 3 } })
  assert.equal(res.phase, 'code_edit')
  assert.equal(res.stepClass, 'engineering')
  assert.equal(res.suggestedTier, 'strong')
  assert.equal(res.suggestedEffort, 'high')
})
