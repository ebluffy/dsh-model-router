/**
 * dsh-model-router — step phase classifier (v0.15).
 *
 * Implements intelligent 3-tier routing per action type:
 *   1. Tool loop / search / file reads / simple checks -> cheap/fast model, low effort
 *   2. Code synthesis / editing / debugging on error   -> smart/strong model, high effort
 *   3. Final response / deep reasoning                -> strongest model, high/max effort
 */
import { ERROR_TEXT, textOfContent } from './policy.js'

export const EDIT_TOOL_PATTERN = /^(replace_file_content|write_to_file|edit_file|apply_patch|patch|create_file|insert_code|update_file|delete_file)$/i

export const INSPECTION_TOOL_PATTERN = /^(view_file|read_file|read_resource|list_resources|read_url_content|list_dir|dir_list|locate_files|find_by_name|file_search|search_web|web_search|grep_search|grep|glob|search|codegraph_explore|inspect_file|cat|head|tail|manage_task|schedule|ask_question)$/i

export const COMMAND_TOOL_PATTERN = /^(run_command|exec_command|bash|terminal|command|sh)$/i

/**
 * Check if a tool call name is a code editing/writing operation.
 */
export function isEditTool(name) {
  if (!name || typeof name !== 'string') return false
  return EDIT_TOOL_PATTERN.test(name) || /edit|write|patch/i.test(name)
}

/**
 * Check if a tool call name is an inspection/reading/search operation.
 */
export function isInspectionTool(name) {
  if (!name || typeof name !== 'string') return false
  return INSPECTION_TOOL_PATTERN.test(name)
}

/**
 * Analyze the trailing messages in a conversation to determine the current step phase.
 * @param {object} opts
 * @param {Array} opts.messages - conversation message list
 * @param {object} opts.payload - payload containing turn and step
 * @param {string} opts.userText - initial user prompt text
 * @param {object} opts.cfg - router configuration
 * @returns {object} { phase, stepClass, suggestedTier, suggestedEffort, reason, bypassHysteresis }
 */
export function classifyStepPhase({ messages = [], payload = {}, userText = '', cfg = {} }) {
  const step = typeof payload.step === 'number' ? payload.step : 0

  // 1. Initial prompt (step 0 or trailing message is a user prompt without tool-results)
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
  const lastRole = lastMsg ? (typeof lastMsg.role === 'string' ? lastMsg.role : lastMsg.type) : ''
  const hasToolResultAtEnd = lastMsg && Array.isArray(lastMsg.content) && lastMsg.content.some((p) => p && p.type === 'tool-result')

  if (step === 0 || messages.length === 0 || (lastRole === 'user' && !hasToolResultAtEnd)) {
    return {
      phase: 'initial',
      stepClass: null, // Defer to base classifyStep
      suggestedTier: null,
      suggestedEffort: null,
      reason: 'direct user prompt',
      bypassHysteresis: false,
    }
  }

  // 2. Intermediate steps (step > 0): inspect the trailing interaction
  let lastUserToolResultMsg = null
  let lastAssistantMsg = null

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg) continue
    const role = typeof msg.role === 'string' ? msg.role : msg.type
    if (role === 'user' && !lastUserToolResultMsg) {
      if (Array.isArray(msg.content) && msg.content.some((p) => p && p.type === 'tool-result')) {
        lastUserToolResultMsg = msg
      }
    } else if (role === 'assistant' && !lastAssistantMsg) {
      lastAssistantMsg = msg
      if (lastUserToolResultMsg) break
    }
  }

  // If there are tool results in the trailing message:
  if (lastUserToolResultMsg && Array.isArray(lastUserToolResultMsg.content)) {
    const results = lastUserToolResultMsg.content.filter((p) => p && p.type === 'tool-result')

    // A. Check for tool execution errors:
    let hasError = false
    for (const res of results) {
      if (res.isError === true) {
        hasError = true
        break
      }
      const text = textOfContent(res.content)
      if (ERROR_TEXT.test(text)) {
        hasError = true
        break
      }
    }

    if (hasError) {
      return {
        phase: 'debugging',
        stepClass: 'engineering',
        suggestedTier: 'strong',
        suggestedEffort: 'high',
        reason: 'tool error recovery & debugging (requires smart model)',
        bypassHysteresis: false,
      }
    }

    // B. Check what tools were executed by the assistant:
    const assistantCalls = []
    if (lastAssistantMsg && Array.isArray(lastAssistantMsg.content)) {
      for (const part of lastAssistantMsg.content) {
        if (part && part.type === 'tool-call') {
          assistantCalls.push(part.name || '')
        }
      }
    }

    // If any tool modified code:
    const hasEdit = assistantCalls.some(isEditTool)
    if (hasEdit) {
      return {
        phase: 'code_edit',
        stepClass: 'engineering',
        suggestedTier: 'strong',
        suggestedEffort: 'high',
        reason: 'code synthesis & editing verification',
        bypassHysteresis: false,
      }
    }

    // If all tools are inspection or clean command tools:
    const allInspection = assistantCalls.length > 0 && assistantCalls.every((name) => {
      return isInspectionTool(name) || COMMAND_TOOL_PATTERN.test(name)
    })

    if (allInspection || (assistantCalls.length === 0 && results.length > 0)) {
      return {
        phase: 'inspection',
        stepClass: 'standard',
        suggestedTier: 'cheap',
        suggestedEffort: 'low',
        reason: 'inspection tool loop (fast & cheap model)',
        bypassHysteresis: true, // Switch immediately to cheap without delay
      }
    }
  }

  // C. If the assistant finished tool execution and is synthesizing final response:
  if (lastAssistantMsg && !lastUserToolResultMsg) {
    return {
      phase: 'synthesis',
      stepClass: 'hard',
      suggestedTier: 'strong',
      suggestedEffort: 'high',
      reason: 'final response synthesis & complex reasoning',
      bypassHysteresis: false,
    }
  }

  return {
    phase: 'general',
    stepClass: null,
    suggestedTier: null,
    suggestedEffort: null,
    reason: 'standard step',
    bypassHysteresis: false,
  }
}
