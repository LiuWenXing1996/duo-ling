import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from '../conversation'
import {
  Message,
  MessageActions,
  MessageAvatar,
  MessageContent,
  MessageToolbar,
} from '../message'

describe('ai-elements conversation + message 冒烟渲染', () => {
  it('能渲染静态 Conversation 容器', () => {
    const wrapper = mount({
      components: { Conversation, ConversationContent, ConversationEmptyState },
      template: `
        <Conversation aria-label="冒烟测试">
          <ConversationContent>
            <ConversationEmptyState title="暂无消息" />
          </ConversationContent>
        </Conversation>
      `,
    })

    expect(wrapper.find('[role="log"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂无消息')
  })

  it('能渲染 assistant 消息结构', () => {
    const wrapper = mount({
      components: {
        Conversation,
        ConversationContent,
        Message,
        MessageAvatar,
        MessageContent,
        MessageActions,
        MessageToolbar,
      },
      template: `
        <Conversation>
          <ConversationContent>
            <Message from="assistant">
              <MessageAvatar src="https://example.com/avatar.png" name="AI" />
              <MessageContent>这是助手回复</MessageContent>
              <MessageActions>
                <MessageToolbar>工具栏</MessageToolbar>
              </MessageActions>
            </Message>
          </ConversationContent>
        </Conversation>
      `,
    })

    expect(wrapper.find('.is-assistant').exists()).toBe(true)
    expect(wrapper.text()).toContain('这是助手回复')
  })
})
