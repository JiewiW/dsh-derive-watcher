// dsh-derive-watcher 客户端半边：在 DSH 设置面板里挂一个「语义监视者」页签。
// 表单完全由 host 侧 GET /plugins/derive-watcher/settings 返回的 schema 驱动
// （字段约定 key/label/type/min/max/options/group/hint），改完 POST 回去即时
// 生效——host 侧 applyRuntimeSettings 会立刻重算设置，无需重启宿主。
//
// 格式说明：dsh 的 web client 模块必须手写 window.__ModuleLoader__.load({id,factory})
// 壳。打包器把各插件的 client.js 原样拼进 /plugins/?? combo，不会再补函数壳；
// 若在文件顶层直接 `return {...}`，拼进 bundle 后会落在脚本顶层作用域
// → SyntaxError: Illegal return statement → 整个 client bundle 解析失败
// → 页面「Failed to load plugins」。故此处必须保持 shell 形态。
//
// 颜色：只使用 dsh 官方主题变量 --dsw-alias-*，并带深色兜底值，
// 避免主题变量缺失时退化成白底白字。
window.__ModuleLoader__.load({
  id: 'dsh-derive-watcher',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var THEME = {
      surface: 'var(--dsw-alias-bg-layer-1, #23262e)',
      surfaceRaised: 'var(--dsw-alias-bg-layer-2, #2b2f38)',
      border: 'var(--dsw-alias-border-l1, #3a3f4b)',
      borderStrong: 'var(--dsw-alias-border-l2, #4a5160)',
      text: 'var(--dsw-alias-label-primary, #e6e8ee)',
      textSecondary: 'var(--dsw-alias-label-secondary, #a8adba)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #7d8391)',
      accent: 'var(--dsw-alias-brand-primary, #4a9eff)',
      accentInverted: 'var(--dsw-alias-brand-primary-invert, #ffffff)',
      danger: 'var(--dsw-alias-state-error-primary, #e0524a)',
      success: 'var(--dsw-alias-state-success-primary, #3f9d5a)',
      // timeline 干预/警示专用。宿主真实暖色别名是缩写形 state-warn-primary
      // （rc.1/rc.2 的 ui-theme/design-platform.css 都只有缩写形；长写法
      // state-warning-primary 不存在，用了会退化成兜底色），此处按缩写形取。
      // 底色用 color-mix 在前景色上掺透明，不引入新 hex 之外的硬编码色板。
      warning: 'var(--dsw-alias-state-warn-primary, #d89614)',
      warningSoft: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d89614) 14%, transparent)',
      dangerSoft: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #e0524a) 12%, transparent)'
    }

    var SETTINGS_API = '/plugins/derive-watcher/settings'

    function numberInputStyle() {
      return {
        width: 110,
        padding: '4px 8px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4
      }
    }

    function textInputStyle() {
      return {
        width: '100%',
        maxWidth: 380,
        padding: '4px 8px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4
      }
    }

    function selectStyle() {
      return {
        padding: '4px 8px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4
      }
    }

    function primaryButtonStyle() {
      return {
        padding: '6px 16px',
        background: THEME.accent,
        color: THEME.accentInverted,
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer'
      }
    }

    function secondaryButtonStyle() {
      return {
        padding: '6px 16px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4,
        cursor: 'pointer'
      }
    }

    function checkboxStyle() {
      return { width: 16, height: 16, cursor: 'pointer', accentColor: THEME.accent }
    }

    /** 多选项取值归一为数组。 */
    function asArray(value) {
      return Array.isArray(value) ? value.slice() : []
    }

    /** 单个 schema 项的控件（boolean/number/text/select/multi-select）。 */
    function Control(props) {
      var spec = props.spec
      var value = props.value
      var onChange = props.onChange
      var type = spec.type || 'text'

      if (type === 'boolean') {
        return h('input', {
          type: 'checkbox',
          checked: value === true,
          style: checkboxStyle(),
          onChange: function (e) { onChange(e.target.checked) }
        })
      }

      if (type === 'number') {
        return h('input', {
          type: 'number',
          value: value === undefined || value === null ? '' : String(value),
          min: spec.min,
          max: spec.max,
          style: numberInputStyle(),
          onChange: function (e) {
            var raw = e.target.value
            onChange(raw === '' ? '' : Number(raw))
          }
        })
      }

      if (type === 'select') {
        var options = spec.options || []
        return h(
          'select',
          {
            value: value === undefined || value === null ? '' : String(value),
            style: selectStyle(),
            onChange: function (e) { onChange(e.target.value) }
          },
          options.map(function (opt) {
            // options 元素为 {value,label}（label 缺失时退回 value），显示人话、传内部值
            var opt_value = opt && typeof opt === 'object' ? opt.value : opt
            var opt_label = opt && typeof opt === 'object' && opt.label ? opt.label : opt_value
            return h('option', { key: opt_value, value: opt_value }, opt_label)
          })
        )
      }

      if (type === 'multi-select') {
        var options2 = spec.options || []
        var selected = asArray(value)
        return h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
          options2.map(function (opt) {
            var opt_value = opt && typeof opt === 'object' ? opt.value : opt
            var opt_label = opt && typeof opt === 'object' && opt.label ? opt.label : opt_value
            return h(
              'label',
              {
                key: opt_value,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color: THEME.text,
                  cursor: 'pointer'
                }
              },
              [
                h('input', {
                  key: 'c',
                  type: 'checkbox',
                  checked: selected.indexOf(opt_value) >= 0,
                  style: checkboxStyle(),
                  onChange: function (e) {
                    var next = asArray(value)
                    var idx = next.indexOf(opt_value)
                    if (e.target.checked) {
                      if (idx < 0) next.push(opt_value)
                    } else if (idx >= 0) {
                      next.splice(idx, 1)
                    }
                    onChange(next)
                  }
                }),
                h('span', { key: 't' }, opt_label)
              ]
            )
          })
        )
      }

      return h('input', {
        type: 'text',
        value: value === undefined || value === null ? '' : String(value),
        style: textInputStyle(),
        onChange: function (e) { onChange(e.target.value) }
      })
    }

    /** 按 group 归并 schema（保持首次出现顺序）。 */
    function collectGroups(schema) {
      var groups = []
      var index = {}
      for (var i = 0; i < schema.length; i++) {
        var spec = schema[i]
        var name = spec.group || '其他'
        if (!index[name]) {
          index[name] = { name: name, items: [] }
          groups.push(index[name])
        }
        index[name].items.push(spec)
      }
      return groups
    }

    /** 能力指示灯：AI 总结 / 卡死拦截 / 注入 / 记录存放位置。 */
    function CapabilityBar(props) {
      var caps = props.caps
      if (!caps) return null
      var items = [
        { label: 'AI 自动总结', on: caps.llm === true },
        { label: '卡死拦截', on: caps.stepGovernor === true },
        { label: '自动塞回小结', on: caps.injection === true }
      ]
      var children = items.map(function (item) {
        return h(
          'span',
          {
            key: item.label,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: item.on ? THEME.success : THEME.textTertiary
            }
          },
          [
            h(
              'span',
              {
                key: 'dot',
                style: {
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: item.on ? THEME.success : THEME.borderStrong
                }
              }
            ),
            h('span', { key: 't' }, item.label + (item.on ? ' 就绪' : ' 未就绪'))
          ]
        )
      })
      if (caps.ledgerRoot) {
        children.push(
          h(
            'span',
            {
              key: 'root',
              style: {
                fontSize: 11,
                color: THEME.textTertiary,
                fontFamily: 'monospace',
                wordBreak: 'break-all'
              }
            },
            '记录存放目录：' + caps.ledgerRoot
          )
        )
      }
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 14,
            marginBottom: 12,
            padding: '8px 10px',
            background: THEME.surfaceRaised,
            border: '1px solid ' + THEME.border,
            borderRadius: 4
          }
        },
        children
      )
    }

    function DeriveWatcherPanel() {
      var payloadState = React.useState(null)
      var payload = payloadState[0]
      var setPayload = payloadState[1]

      var draftState = React.useState({})
      var draft = draftState[0]
      var setDraft = draftState[1]

      var loadingState = React.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]

      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]

      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var errorState = React.useState('')
      var errorMessage = errorState[0]
      var setErrorMessage = errorState[1]

      function load() {
        fetch(SETTINGS_API)
          .then(function (res) { return res.json() })
          .then(function (body) {
            if (!body || body.ok !== true) {
              setErrorMessage('读取设置失败：' + ((body && body.error) || '未知错误'))
            } else {
              setPayload(body)
              setDraft(Object.assign({}, body.settings))
              setErrorMessage('')
            }
            setLoading(false)
          })
          .catch(function (err) {
            setErrorMessage('读取设置失败：' + (err && err.message ? err.message : String(err)))
            setLoading(false)
          })
      }

      React.useEffect(load, [])

      function persist() {
        setSaving(true)
        setNotice('')
        fetch(SETTINGS_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: draft })
        })
          .then(function (res) { return res.json() })
          .then(function (body) {
            if (!body || body.ok !== true) {
              var detail = body && body.errors && body.errors.length
                ? body.errors.join('；')
                : ((body && body.error) || '未知错误')
              setErrorMessage('保存失败：' + detail)
              return
            }
            setErrorMessage('')
            setDraft(Object.assign({}, body.settings))
            setPayload(function (prev) {
              var caps = prev && prev.capabilities
                ? Object.assign({}, prev.capabilities, { injection: body.settings.enableInjection === true })
                : prev && prev.capabilities
              return Object.assign({}, prev, { settings: body.settings, capabilities: caps })
            })
            var warns = body.warnings && body.warnings.length
              ? '（' + body.warnings.join('；') + '）'
              : ''
            setNotice('已保存并即时生效' + warns)
          })
          .catch(function (err) {
            setErrorMessage('保存失败：' + (err && err.message ? err.message : String(err)))
          })
          .then(function () { setSaving(false) })
      }

      if (loading) {
        return h('div', { style: { padding: 16, color: THEME.textSecondary } }, '正在读取设置…')
      }
      if (!payload) {
        return h('div', { style: { padding: 16, color: THEME.danger } }, errorMessage || '设置不可用')
      }

      var schema = payload.schema || []
      var groups = collectGroups(schema)
      var dirty = JSON.stringify(draft) !== JSON.stringify(payload.settings || {})

      var children = []

      children.push(
        h('div', { key: 'head', style: { marginBottom: 10 } }, [
          h('div', { key: 't', style: { fontSize: 14, fontWeight: 600 } }, '语义监视者'),
          h(
            'div',
            {
              key: 'd',
              style: { fontSize: 12, color: THEME.textTertiary, marginTop: 4, lineHeight: 1.7 }
            },
            '在后台记录这个会话里 AI 每一步在做什么，自动生成阶段小结，发现 AI 卡住打转时提醒或拦住，并把小结塞回上下文防止跑题。' +
              '几项开关之间有先后关系：开启「把阶段小结自动塞回对话」之前，卡死拦截那两项不能开；' +
              '三级卡死的三个数字必须从一级到三级严格递增，写反了会被拒绝保存。'
          )
        ])
      )

      children.push(h(CapabilityBar, { key: 'caps', caps: payload.capabilities }))

      groups.forEach(function (group, gi) {
        children.push(
          h('div', { key: 'g' + gi, style: { marginBottom: 14 } }, [
            h(
              'div',
              {
                key: 'h',
                style: {
                  fontSize: 12,
                  fontWeight: 600,
                  color: THEME.textSecondary,
                  marginBottom: 6,
                  paddingBottom: 4,
                  borderBottom: '1px solid ' + THEME.border
                }
              },
              group.name
            ),
            h(
              'div',
              { key: 'b' },
              group.items.map(function (spec) {
                return h(
                  'div',
                  {
                    key: spec.key,
                    style: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '6px 0' }
                  },
                  [
                    h('div', { key: 'l', style: { width: 220, flexShrink: 0 } }, [
                      h('div', { key: 'n', style: { fontSize: 13, color: THEME.text } }, spec.label || spec.key),
                      spec.hint
                        ? h(
                            'div',
                            {
                              key: 'h',
                              style: {
                                fontSize: 11,
                                color: THEME.textTertiary,
                                marginTop: 2,
                                lineHeight: 1.6
                              }
                            },
                            spec.hint
                          )
                        : null
                    ]),
                    h(
                      'div',
                      { key: 'c', style: { flex: 1, paddingTop: 2 } },
                      h(Control, {
                        spec: spec,
                        value: draft[spec.key],
                        onChange: function (v) {
                          setDraft(function (prev) {
                            var next = Object.assign({}, prev)
                            next[spec.key] = v
                            return next
                          })
                          setNotice('')
                        }
                      })
                    )
                  ]
                )
              })
            )
          ])
        )
      })

      children.push(
        h(
          'div',
          {
            key: 'foot',
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
              marginTop: 8,
              paddingTop: 12,
              borderTop: '1px solid ' + THEME.border
            }
          },
          [
            h(
              'button',
              {
                key: 's',
                style: primaryButtonStyle(),
                disabled: saving,
                onClick: persist
              },
              saving ? '保存中…' : '保存并即时生效'
            ),
            h(
              'button',
              {
                key: 'r',
                style: secondaryButtonStyle(),
                onClick: function () {
                  load()
                  setNotice('')
                }
              },
              '重新读取'
            ),
            dirty
              ? h(
                  'span',
                  { key: 'd', style: { fontSize: 12, color: THEME.textTertiary } },
                  '有未保存的改动'
                )
              : null,
            notice
              ? h('span', { key: 'n', style: { fontSize: 12, color: THEME.success } }, notice)
              : null,
            errorMessage
              ? h('span', { key: 'e', style: { fontSize: 12, color: THEME.danger } }, errorMessage)
              : null
          ]
        )
      )

      return h('div', { style: { color: THEME.text } }, children)
    }

    // ── 右侧栏「语义监视」timeline tab（v0.2.0 步骤3）─────────────────────────
    // 数据来源：host GET /plugins/derive-watcher/timeline/sessions 与
    // GET /plugins/derive-watcher/timeline?sessionId=…（同源 fetch，照 SETTINGS_API 写法）。
    // 宿主新版未加载（旧 host 上路由 404 / 返回非 JSON）时显示明确空态，不算崩溃。

    var TIMELINE_SESSIONS_API = '/plugins/derive-watcher/timeline/sessions'
    var TIMELINE_API = '/plugins/derive-watcher/timeline'
    var TIMELINE_POLL_MS = 5000
    var TIMELINE_TAB_KIND = 'derive-watcher-timeline'
    var TIMELINE_TAB_ID = 'dsh-derive-watcher'

    /** journey kind → 中文小标签（与 host lib/timeline.js KIND_LABELS 手工同步，combo 两侧互不可 import）。 */
    var JOURNEY_KIND_LABELS = {
      finding: '发现',
      decision: '决策',
      'dead-end': '死路',
      hypothesis: '假设',
      plan: '计划',
      fact: '事实'
    }

    /** source → 中文徽标（intervention 是 watcher-event 的 action 特化，样式醒目）。 */
    var TIMELINE_SOURCE_LABELS = {
      intervention: '干预',
      'watcher-event': '事件',
      milestone: '里程碑',
      gap: '跳过',
      journey: '条目',
      observation: '观察'
    }

    /** gap grade → 中文徽标（与 host lib/timeline.js GAP_GRADE_TITLES 手工同步，combo 两侧互不可 import）。 */
    var GAP_GRADE_LABELS = {
      'no-adapter': '无模型路由',
      timeout: '超时',
      'parse-error': '解析失败',
      empty: '空回复',
      'empty-ok': '空结果',
      other: '其他故障'
    }

    // apply 时捕获的 sessions 服务引用（Panel 拿不到 ctx，与 side-coder 同款闭包取法）。
    var sessionsRef = null

    /**
     * 当前会话 id：旧内核快照带 current；0.2.0-rc.2 快照已无 current，
     * 等价语义为 retainedBy.mainView > 0（主视图正在持有的行）。取不到返回 null。
     */
    function getCurrentSessionId() {
      if (!sessionsRef || !sessionsRef.list || typeof sessionsRef.list.getSnapshot !== 'function') return null
      var snap = sessionsRef.list.getSnapshot()
      if (!snap) return null
      if (snap.current) return snap.current
      var byId = snap.byId
      if (!byId) return null
      var ids = Object.keys(byId)
      for (var i = 0; i < ids.length; i += 1) {
        var row = byId[ids[i]]
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id || ids[i]
      }
      return null
    }

    /** ts 双形态（毫秒数字 / ISO 字符串）归一为 Date；解析不了返回 null。 */
    function timelineToDate(ts) {
      if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts)
      if (typeof ts === 'string') {
        var parsed = Date.parse(ts)
        if (Number.isFinite(parsed)) return new Date(parsed)
      }
      return null
    }

    /** 静默中断事件（I6）判别：kind 以 silent-abort/ 开头（timeline.js 同口径，归入 intervention 通道）。 */
    function isSilentAbortItem(item) {
      return typeof item.kind === 'string' && item.kind.indexOf('silent-abort/') === 0
    }

    /** 中文相对时间；超过 7 天退化为日期串。 */
    function formatRelativeTime(date, nowMs) {
      if (!date) return '时间未知'
      var diff = nowMs - date.getTime()
      if (diff < 0) diff = 0
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
      if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前'
      return date.toLocaleString()
    }

    /** GET JSON（res.json 失败折成 null，供上层判「旧 host 返回非 JSON」）。 */
    function timelineFetchJson(url) {
      return fetch(url)
        .then(function (res) {
          return res
            .json()
            .catch(function () {
              return null
            })
            .then(function (body) {
              return { status: res.status, body: body }
            })
        })
    }

    /** 节点圆点颜色：干预暖/警示、降级事件红、里程碑/handoff 蓝、其余中性。 */
    function timelineDotColor(item) {
      if (item.source === 'intervention' && isSilentAbortItem(item)) {
        return item.kind === 'silent-abort/escalated' || item.kind === 'silent-abort/cancelled' ? THEME.danger : THEME.warning
      }
      if (item.source === 'intervention') return item.accepted === true ? THEME.warning : THEME.danger
      if (item.source === 'watcher-event' && item.kind === 'execution-unavailable') return THEME.danger
      if (item.source === 'gap') return THEME.warning
      if (item.source === 'milestone') return THEME.accent
      if (item.source === 'watcher-event' && item.kind === 'handoff-written') return THEME.accent
      if (item.source === 'journey') return item.novelty === 'duplicate' ? THEME.textTertiary : THEME.success
      return THEME.borderStrong
    }

    /** 卡片容器样式：干预受理=暖色块；未受理/降级=警示块；里程碑/handoff=左侧蓝边。 */
    function timelineCardBox(item) {
      var style = {
        background: THEME.surfaceRaised,
        border: '1px solid ' + THEME.border,
        borderRadius: 6,
        padding: '7px 10px',
        minWidth: 0
      }
      if (item.source === 'intervention' && isSilentAbortItem(item)) {
        var escalated = item.kind === 'silent-abort/escalated' || item.kind === 'silent-abort/cancelled'
        style.background = escalated ? THEME.dangerSoft : THEME.warningSoft
        style.border = '1px solid ' + (escalated ? THEME.danger : THEME.warning)
      } else if (item.source === 'intervention' && item.accepted === true) {
        style.background = THEME.warningSoft
        style.border = '1px solid ' + THEME.warning
      } else if (item.source === 'intervention') {
        style.background = THEME.dangerSoft
        style.border = '1px solid ' + THEME.danger
      } else if (item.source === 'watcher-event' && item.kind === 'execution-unavailable') {
        style.background = THEME.dangerSoft
        style.border = '1px solid ' + THEME.danger
      } else if (item.source === 'gap') {
        style.background = THEME.warningSoft
        style.border = '1px solid ' + THEME.warning
      } else if (item.source === 'milestone' || (item.source === 'watcher-event' && item.kind === 'handoff-written')) {
        style.borderLeft = '3px solid ' + THEME.accent
      }
      return style
    }

    /** 小徽标（圆角描边文本）。 */
    function TimelineBadge(props) {
      return h(
        'span',
        {
          style: {
            fontSize: 11,
            lineHeight: '16px',
            padding: '0 6px',
            borderRadius: 999,
            border: '1px solid ' + (props.color || THEME.borderStrong),
            color: props.color || THEME.textSecondary,
            flexShrink: 0
          }
        },
        props.text
      )
    }

    /** 单个 timeline 节点卡片（observation 组走 ObservationGroup，不进这里）。 */
    function TimelineItemCard(props) {
      var item = props.item
      var nowMs = props.nowMs
      var meta = []
      if (Number.isFinite(item.turn) || Number.isFinite(item.step)) {
        meta.push('turn ' + (item.turn ?? '?') + ' · step ' + (item.step ?? '?'))
      }
      var badge = null
      if (item.source === 'intervention' && isSilentAbortItem(item)) {
        var isEscalated = item.kind === 'silent-abort/escalated' || item.kind === 'silent-abort/cancelled'
        var isResumed = item.kind === 'silent-abort/resume-sent' || item.kind === 'silent-abort/resolved'
        badge = h(TimelineBadge, {
          key: 'iv',
          text: isEscalated ? '静默中断·人工' : isResumed ? '静默中断·已续跑' : '静默中断',
          color: isEscalated ? THEME.danger : isResumed ? THEME.accent : THEME.warning
        })
      } else if (item.source === 'intervention') {
        badge = h(TimelineBadge, {
          key: 'iv',
          text: item.accepted === true ? '干预已受理' : '干预未受理',
          color: item.accepted === true ? THEME.warning : THEME.danger
        })
      } else if (item.source === 'journey') {
        badge = h(TimelineBadge, {
          key: 'jk',
          text: JOURNEY_KIND_LABELS[item.kind] || String(item.kind || '条目'),
          color: THEME.textSecondary
        })
        if (item.novelty === 'duplicate') {
          badge = [badge, h(TimelineBadge, { key: 'dup', text: '重复', color: THEME.textTertiary })]
        }
      } else if (item.source === 'watcher-event' && item.kind === 'execution-unavailable') {
        badge = h(TimelineBadge, { key: 'un', text: '干预降级', color: THEME.danger })
      } else if (item.source === 'watcher-event' && item.kind === 'handoff-written') {
        badge = h(TimelineBadge, { key: 'ho', text: '交接产出', color: THEME.accent })
      } else if (item.source === 'gap') {
        badge = h(TimelineBadge, {
          key: 'gp',
          text: GAP_GRADE_LABELS[item.grade] || '跳过',
          color: THEME.warning
        })
      }

      return h(
        'div',
        { style: timelineCardBox(item) },
        [
          h(
            'div',
            {
              key: 'head',
              style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }
            },
            [
              h(
                'span',
                { key: 'src', style: { fontSize: 11, color: THEME.textTertiary, flexShrink: 0 } },
                TIMELINE_SOURCE_LABELS[item.source] || item.source
              ),
              badge,
              h('span', { key: 'sp', style: { flex: 1 } }),
              h(
                'span',
                {
                  key: 't',
                  style: { fontSize: 11, color: THEME.textTertiary, flexShrink: 0 },
                  title: meta.join(' ')
                },
                formatRelativeTime(timelineToDate(item.ts), nowMs)
              )
            ]
          ),
          h(
            'div',
            { style: { fontSize: 13, fontWeight: 600, color: THEME.text, wordBreak: 'break-word' } },
            item.title || '（无标题）'
          ),
          item.summary
            ? h(
                'div',
                {
                  style: {
                    fontSize: 12,
                    color: THEME.textSecondary,
                    marginTop: 3,
                    lineHeight: 1.6,
                    wordBreak: 'break-word'
                  }
                },
                item.summary
              )
            : null,
          meta.length
            ? h(
                'div',
                { style: { fontSize: 11, color: THEME.textTertiary, marginTop: 3 } },
                meta.join(' · ')
              )
            : null
        ]
      )
    }

    /** 连续 observation 折叠块：默认收起只显示条数，展开才列明细（低对比样式）。 */
    function ObservationGroup(props) {
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var items = props.items
      var nowMs = props.nowMs
      var steps = items
        .map(function (it) {
          return it.step
        })
        .filter(function (s) {
          return Number.isFinite(s)
        })
      var stepRange = ''
      if (steps.length) {
        var minStep = Math.min.apply(null, steps)
        var maxStep = Math.max.apply(null, steps)
        stepRange = ' · step ' + minStep + (maxStep === minStep ? '' : '–' + maxStep)
      }
      var children = [
        h(
          'div',
          {
            key: 'h',
            style: { fontSize: 12, color: THEME.textTertiary, cursor: 'pointer', userSelect: 'none' },
            onClick: function () {
              setOpen(!open)
            }
          },
          (open ? '▾ ' : '▸ ') + '每步观察 ' + items.length + ' 条' + stepRange + '（' + (open ? '点击收起' : '点击展开') + '）'
        )
      ]
      if (open) {
        children.push(
          h(
            'div',
            { key: 'l', style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 } },
            items.map(function (item) {
              return h(
                'div',
                {
                  key: item.id,
                  style: { fontSize: 11, color: THEME.textTertiary, lineHeight: 1.6 }
                },
                '· ' +
                  (item.title || '') +
                  (item.summary ? ' — ' + item.summary : '') +
                  ' · ' +
                  formatRelativeTime(timelineToDate(item.ts), nowMs)
              )
            })
          )
        )
      }
      return h(
        'div',
        {
          style: {
            background: THEME.surface,
            border: '1px dashed ' + THEME.border,
            borderRadius: 6,
            padding: '6px 10px',
            minWidth: 0
          }
        },
        children
      )
    }

    /** 把排好序的 items 里连续 observation 合并为折叠组，其余单节点。 */
    function groupTimelineItems(items) {
      var blocks = []
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i]
        if (item.source === 'observation') {
          var last = blocks.length ? blocks[blocks.length - 1] : null
          if (last && last.type === 'obsGroup') {
            last.items.push(item)
          } else {
            blocks.push({ type: 'obsGroup', items: [item] })
          }
        } else {
          blocks.push({ type: 'item', item: item })
        }
      }
      return blocks
    }

    function TimelinePanel() {
      var sessionsState = React.useState([])
      var sessionsList = sessionsState[0]
      var setSessionsList = sessionsState[1]

      var selectedState = React.useState(null)
      var selectedSid = selectedState[0]
      var setSelectedSid = selectedState[1]

      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]

      var loadingState = React.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]

      var errorState = React.useState('')
      var errorMessage = errorState[0]
      var setErrorMessage = errorState[1]

      var missingState = React.useState(false)
      var hostMissing = missingState[0]
      var setHostMissing = missingState[1]

      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var heartbeatState = React.useState(false)
      var showHeartbeat = heartbeatState[0]
      var setShowHeartbeat = heartbeatState[1]

      function loadTimeline(sid, silent) {
        if (!silent && !data) setLoading(true)
        timelineFetchJson(TIMELINE_API + '?sessionId=' + encodeURIComponent(sid))
          .then(function (r) {
            if (!r.body || typeof r.body !== 'object') {
              // 旧 host：路由不存在，返回 HTML/空 → 明确空态而非报错崩溃
              setHostMissing(true)
              setLoading(false)
              return
            }
            if (r.body.ok !== true) {
              setHostMissing(false)
              setData({ sessionId: sid, items: [], counts: {}, warnings: [], limit: 0 })
              setErrorMessage(r.body.error || '接口返回异常（status ' + r.status + '）')
              setLoading(false)
              return
            }
            setHostMissing(false)
            setErrorMessage('')
            setData(r.body)
            setLoading(false)
          })
          .catch(function (err) {
            setErrorMessage('请求失败：' + (err && err.message ? err.message : String(err)))
            setLoading(false)
          })
      }

      function loadSessions() {
        timelineFetchJson(TIMELINE_SESSIONS_API)
          .then(function (r) {
            if (!r.body || typeof r.body !== 'object') {
              setHostMissing(true)
              setLoading(false)
              return
            }
            if (r.body.ok !== true) {
              setErrorMessage('读取会话列表失败：' + (r.body.error || '未知错误'))
              setLoading(false)
              return
            }
            var list = Array.isArray(r.body.sessions) ? r.body.sessions : []
            setSessionsList(list)
            var current = getCurrentSessionId()
            var found = null
            for (var i = 0; i < list.length; i += 1) {
              if (list[i] && list[i].sessionId === current) {
                found = current
                break
              }
            }
            if (found) {
              setSelectedSid(found)
            } else if (list.length) {
              setSelectedSid(list[0].sessionId)
              setNotice(current ? '当前会话不在列表，已选中最近会话' : '未能确定当前会话，已选中列表第一个')
            } else {
              setLoading(false)
            }
          })
          .catch(function (err) {
            setErrorMessage('读取会话列表失败：' + (err && err.message ? err.message : String(err)))
            setLoading(false)
          })
      }

      React.useEffect(loadSessions, [])

      React.useEffect(
        function () {
          if (!selectedSid) return undefined
          loadTimeline(selectedSid)
          var timer = setInterval(
            function () {
              if (typeof document !== 'undefined' && document.hidden) return
              loadTimeline(selectedSid, true)
            },
            TIMELINE_POLL_MS
          )
          return function () {
            clearInterval(timer)
          }
        },
        [selectedSid]
      )

      var children = []

      children.push(
        h(
          'div',
          {
            key: 'head',
            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
          },
          [
            h('select', {
              key: 'sel',
              style: selectStyle(),
              value: selectedSid || '',
              disabled: !sessionsList.length,
              onChange: function (ev) {
                setSelectedSid(ev.target.value)
                setNotice('')
              }
            },
              sessionsList.length
                ? sessionsList.map(function (row) {
                    return h(
                      'option',
                      { key: row.sessionId, value: row.sessionId },
                      (row.title || row.sessionId) + (row.hasLedger ? '' : '（无账本）')
                    )
                  })
                : [h('option', { key: 'none', value: '' }, '暂无会话')]),
            h(
              'button',
              {
                key: 'r',
                style: secondaryButtonStyle(),
                onClick: function () {
                  loadSessions()
                  if (selectedSid) loadTimeline(selectedSid)
                }
              },
              '刷新'
            ),
            h(
              'label',
              {
                key: 'hb',
                style: {
                  fontSize: 11,
                  color: THEME.textTertiary,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer'
                }
              },
              [
                h('input', {
                  key: 'c',
                  type: 'checkbox',
                  checked: showHeartbeat,
                  onChange: function (ev) {
                    setShowHeartbeat(ev.target.checked)
                  }
                }),
                '显示心跳'
              ]
            ),
            h(
              'span',
              { key: 'hint', style: { fontSize: 11, color: THEME.textTertiary } },
              '每 5 秒自动刷新'
            )
          ]
        )
      )

      if (notice) {
        children.push(
          h('div', { key: 'notice', style: { fontSize: 11, color: THEME.textTertiary } }, notice)
        )
      }

      if (hostMissing) {
        children.push(
          h(
            'div',
            {
              key: 'missing',
              style: {
                border: '1px solid ' + THEME.warning,
                background: THEME.warningSoft,
                borderRadius: 6,
                padding: '10px 12px',
                fontSize: 12,
                lineHeight: 1.7
              }
            },
            [
              h('div', { key: 't', style: { fontWeight: 600 } }, '宿主尚未加载本插件新版'),
              h(
                'div',
                { key: 'd', style: { color: THEME.textSecondary } },
                'timeline 接口不可用（当前运行的 host 还没有这些路由）。重启 dsh web 后即生效。'
              ),
              h(
                'button',
                {
                  key: 'b',
                  style: secondaryButtonStyle(),
                  onClick: function () {
                    setHostMissing(false)
                    loadSessions()
                    if (selectedSid) loadTimeline(selectedSid)
                  }
                },
                '重试'
              )
            ]
          )
        )
      } else if (errorMessage) {
        children.push(
          h(
            'div',
            {
              key: 'err',
              style: {
                border: '1px solid ' + THEME.danger,
                background: THEME.dangerSoft,
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap'
              }
            },
            [
              h('span', { key: 'm', style: { color: THEME.danger } }, errorMessage),
              h(
                'button',
                {
                  key: 'b',
                  style: secondaryButtonStyle(),
                  onClick: function () {
                    loadSessions()
                    if (selectedSid) loadTimeline(selectedSid)
                  }
                },
                '重试'
              )
            ]
          )
        )
      } else if (loading && !data) {
        children.push(
          h('div', { key: 'ld', style: { fontSize: 12, color: THEME.textSecondary, padding: '8px 0' } }, '正在读取 timeline…')
        )
      } else if (!sessionsList.length) {
        children.push(
          h(
            'div',
            { key: 'empty', style: { fontSize: 12, color: THEME.textSecondary, padding: '10px 0', lineHeight: 1.7 } },
            '暂无会话记录。插件在后台观察会话时会自动建立记录；若刚启用本插件，先聊几步再回来看。'
          )
        )
      } else if (data) {
        var items = Array.isArray(data.items) ? data.items : []
        var visibleItems = showHeartbeat
          ? items
          : items.filter(function (it) {
              return !(it.source === 'watcher-event' && it.kind === 'heartbeat')
            })
        var hiddenHeartbeats = items.length - visibleItems.length
        var totalCounts = 0
        var countBits = []
        var countsObj = data.counts || {}
        Object.keys(countsObj).forEach(function (src) {
          totalCounts += countsObj[src]
          countBits.push((TIMELINE_SOURCE_LABELS[src] || src) + ' ' + countsObj[src])
        })
        children.push(
          h(
            'div',
            { key: 'stat', style: { fontSize: 11, color: THEME.textTertiary } },
            countBits.join(' · ') || '（空）'
          )
        )
        if (data.warnings && data.warnings.length) {
          children.push(
            h(
              'div',
              { key: 'warn', style: { fontSize: 11, color: THEME.warning } },
              '数据源提示：' + data.warnings.join('；')
            )
          )
        }
        if (!visibleItems.length) {
          children.push(
            h(
              'div',
              { key: 'noitem', style: { fontSize: 12, color: THEME.textSecondary, padding: '10px 0', lineHeight: 1.7 } },
              hiddenHeartbeats > 0
                ? '当前仅有 ' + hiddenHeartbeats + ' 条心跳记录（默认折叠）。勾选「显示心跳」可查看；模型产生语义结论后会出现条目与里程碑。'
                : '该会话暂无 timeline 条目。语义条目、跳过、事件、干预与每步观察会随对话推进实时出现在这里。'
            )
          )
        } else {
          var nowMs = Date.now()
          var blocks = groupTimelineItems(visibleItems)
          children.push(
            h(
              'div',
              {
                key: 'tl',
                style: { position: 'relative', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }
              },
              [
                h('div', {
                  key: 'line',
                  'aria-hidden': true,
                  style: { position: 'absolute', left: 4, top: 4, bottom: 4, width: 1, background: THEME.border }
                })
              ].concat(
                blocks.map(function (block) {
                  var dotColor = block.type === 'obsGroup' ? THEME.borderStrong : timelineDotColor(block.item)
                  return h(
                    'div',
                    { key: block.type === 'obsGroup' ? block.items[0].id : block.item.id, style: { position: 'relative' } },
                    [
                      h('div', {
                        key: 'dot',
                        'aria-hidden': true,
                        style: {
                          position: 'absolute',
                          left: -17,
                          top: 10,
                          width: 9,
                          height: 9,
                          borderRadius: '50%',
                          background: dotColor,
                          outline: '2px solid ' + THEME.surface
                        }
                      }),
                      block.type === 'obsGroup'
                        ? h(ObservationGroup, { items: block.items, nowMs: nowMs })
                        : h(TimelineItemCard, { item: block.item, nowMs: nowMs })
                    ]
                  )
                })
              )
            )
          )
          if (data.limit && items.length >= data.limit && totalCounts > items.length) {
            children.push(
              h(
                'div',
                { key: 'trunc', style: { fontSize: 11, color: THEME.textTertiary } },
                '仅显示最近 ' + visibleItems.length + ' 条（共 ' + totalCounts + ' 条）' +
                  (hiddenHeartbeats > 0 ? '，其中 ' + hiddenHeartbeats + ' 条心跳已折叠' : '')
              )
            )
          }
        }
      }

      return h(
        'div',
        {
          style: {
            color: THEME.text,
            fontSize: 13,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            overflowY: 'auto'
          }
        },
        children
      )
    }

    function apply(ctx) {
      var slots = ctx.slots

      slots.inject('settings.section', function () {
        slots.register(
          { name: 'settings.section', id: 'derive-watcher', label: '语义监视者', order: 997 },
          DeriveWatcherPanel
        )
      })

      // ── 右栏「语义监视」tab（v0.2.0 步骤3）──
      // sessions 供 Panel 取当前会话；sidebarRight / sidebarRightTabs 判空静默降级
      // （拿不到就只不注册 tab，绝不抛错影响上面的设置页签）。
      sessionsRef = ctx.sessions || null
      var tabsRegistry = ctx.sidebarRightTabs
      if (tabsRegistry && typeof tabsRegistry.register === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return tabsRegistry.register({
            id: TIMELINE_TAB_ID,
            kind: TIMELINE_TAB_KIND,
            title: function () {
              return '语义监视'
            },
            guide: [
              {
                order: 26,
                title: function () {
                  return '语义监视'
                },
                description: function () {
                  return '后台观察记录与 step-governor 干预的纵向时间线'
                }
              }
            ]
          })
        }, 'derive-watcher tab type')
        ctx.effect(function () {
          return slots.inject('sidebar.right.pane.tab', function () {
            return slots.register(
              { name: 'sidebar.right.pane.tab', key: TIMELINE_TAB_ID },
              TimelinePanel
            )
          })
        }, 'derive-watcher tab body')
        ctx.effect(function () {
          return slots.inject('sidebar.right.pane.tab.title', function () {
            return slots.register(
              { name: 'sidebar.right.pane.tab.title', key: TIMELINE_TAB_ID },
              function () {
                return h('span', null, '👁 语义监视')
              }
            )
          })
        }, 'derive-watcher tab title')
      }
    }

    exports.inject = ['slots', 'sessions', 'sidebarRight', 'sidebarRightTabs']
    exports.apply = apply
    return module.exports
  }
})
