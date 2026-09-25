/**
 * 图标动效的渲染与交互绑定层：把弹簧姿态写成 SVG 属性。
 *
 * 移植自设计稿 `svg-anim/nav-motion.js`，只改模块边界（ESM）并对外暴露 `reverse()`。
 * 姿态→属性的映射是设计稿逐图标调出来的，改动前请对照原稿。
 */

import { createModel, type NavModel, type NavPose } from './navIconPhysics'

const clamp = (x: number) => Math.max(0, Math.min(1, x))
const around = (x: number, y: number, sx: number, sy = sx) =>
  `translate(${x} ${y}) scale(${sx} ${sy}) translate(${-x} ${-y})`

const caches = new WeakMap<SVGSVGElement, Record<string, SVGGElement>>()

function partsFor(svg: SVGSVGElement): Record<string, SVGGElement> {
  let cached = caches.get(svg)
  if (!cached) {
    cached = Object.fromEntries(
      [...svg.querySelectorAll<SVGGElement>('[data-part]')].map(el => [el.dataset.part!, el]),
    )
    caches.set(svg, cached)
  }
  return cached
}

export function paint(svg: SVGSVGElement, pose: NavPose) {
  const parts = partsFor(svg)
  const attr = (name: string, key: string, value: string | number) => {
    parts[name]?.setAttribute(key, String(value))
  }
  const transform = (name: string, value: string) => attr(name, 'transform', value)
  const { body, detail, bars, fills, angle, ink } = pose
  // 统计图柱子自己压，整体不压，基线才稳；其余图标统一 3% 压缩
  transform('body', svg.dataset.icon === 'statistics' ? '' : around(12, 12, 1 - 0.03 * body))

  switch (svg.dataset.icon) {
    case 'setting':
      transform('rotor', `rotate(${angle} 12 12)`)
      break

    case 'app_usage':
      transform('minute', `rotate(${angle} 12 12)`)
      // 真实钟表比例；时针前进量跨次点击保留
      transform('hour', `rotate(${angle / 12} 12 12)`)
      break

    case 'note':
      // 两行文字都待在会动的纸张坐标系里
      transform('sheet', `rotate(${-6 * detail} 12 18)`)
      ink.forEach((value, i) => {
        const length = [8, 6][i]! * Math.max(0.5, Math.min(1.04, 1 - 0.42 * value))
        parts[`ink${i + 1}`]?.querySelector('path')?.setAttribute('d', `M8 ${12 + i * 4}h${length}`)
      })
      break

    case 'statistics':
      bars.forEach((value: number, i: number) => {
        const natural = [6, 10, 13][i]!
        const height = natural * (1 - 0.26 * value)
        // 改几何高度而不是 scaleY：圆角与描边粗细才不会被拉变形；
        // 填充层与轮廓层同几何，所以填充不可能越出轮廓
        parts[`bar${i}`]?.querySelectorAll('rect').forEach(rect => {
          rect.setAttribute('y', String(18 - height))
          rect.setAttribute('height', String(height))
        })
        attr(`fill${i}`, 'opacity', clamp(fills[i]!) * 0.88)
      })
      break

    case 'clip':
      // 板身与夹子同向抬起，夹子额外绕顶部铰链开合
      transform('board', `translate(0 ${-0.45 * detail}) rotate(${-2 * detail} 12 12)`)
      transform('clasp', `translate(0 ${-0.55 * detail}) ${around(12, 3, 1, 1 - 0.2 * clamp(detail))}`)
      ink.forEach((value, i) => {
        const length = [6, 4][i]! * Math.max(0.45, Math.min(1.04, 1 - 0.5 * value))
        parts[`ink${i + 1}`]?.querySelector('path')?.setAttribute('d', `M9 ${12 + i * 4}h${length}`)
        attr(`ink${i + 1}`, 'opacity', 1 - 0.25 * clamp(value))
      })
      break

    case 'todo': {
      const checkPath = parts.check?.querySelector('path')
      const retract = clamp(ink[0]!)
      checkPath?.setAttribute('stroke-dasharray', '1')
      checkPath?.setAttribute('stroke-dashoffset', String(0.96 * retract))
      // 收回到起笔处，再先短边后长边重画；墨迹弹簧慢、手势弹簧快，收尾有一点弹出手感
      const finish = Math.max(0, ink[0]! - detail)
      const scale = 1 - 0.1 * retract + 0.24 * finish
      transform('check', `translate(0 ${0.3 * detail}) rotate(${-8 * detail} 11 17) ${around(11, 17, scale)}`)
      break
    }

    case 'pinned': {
      const landing = Math.max(0, -detail)
      transform('pin', `translate(0 ${-2 * detail}) rotate(${-10 * detail} 12 16)`)
      transform('base', around(12, 21, 1 - 0.09 * detail + 0.35 * landing, 1))
      break
    }
  }
}

/** 慢放预览：模拟一次 120ms 轻点，不是真实输入的时钟 */
export function render(svg: SVGSVGElement, progress: number, reduced = false) {
  const model = createModel(svg.dataset.icon ?? '')
  if (!reduced) {
    const duration = 1.3 * clamp(progress)
    model.press()
    model.step(Math.min(0.12, duration))
    if (duration > 0.12) {
      model.release()
      model.step(duration - 0.12)
    }
  }
  paint(svg, model.snapshot())
}

export interface NavMotionOptions {
  onUpdate?: (info: { progress: number; state: string }) => void
}

export interface NavMotionController {
  press(): void
  release(): void
  cancel(): void
  /** 反向回到起点，而不是顺势完成（见 navIconPhysics 的 reverse 说明） */
  reverse(): void
  play(): void
  seek(value: number): void
  setRate(value: number): void
  readonly progress: number
  readonly state: string
  destroy(): void
}

export function create(svg: SVGSVGElement, options: NavMotionOptions = {}): NavMotionController {
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  let model: NavModel = createModel(svg.dataset.icon ?? '')
  let frame = 0
  let last: number | null = null
  let rate = 1
  let destroyed = false
  let preview = false
  let autoRelease: number | null = null

  const draw = () => {
    paint(svg, model.snapshot())
    svg.dataset.state = model.state
    svg.dataset.progress = model.progress.toFixed(4)
    options.onUpdate?.({ progress: model.progress, state: model.state })
  }

  function advance(dt: number) {
    if (autoRelease !== null && model.time + dt >= autoRelease) {
      const first = Math.max(0, autoRelease - model.time)
      model.step(first)
      model.release()
      autoRelease = null
      model.step(dt - first)
    } else model.step(dt)
  }

  function wake() {
    if (!frame && !destroyed) {
      // 保持一个活跃时钟：输入事件绝不插入新的零 dt 帧
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }
  }

  function tick(time: number) {
    frame = 0
    advance(Math.max(0, Math.min(0.05, (time - (last ?? time)) / 1000)) * rate)
    last = time
    draw()
    if (!model.settled || autoRelease !== null) frame = requestAnimationFrame(tick)
  }

  function begin() {
    if (destroyed) return false
    if (preview) {
      model = createModel(svg.dataset.icon ?? '')
      preview = false
    }
    if (media?.matches) {
      model.stop()
      draw()
      return false
    }
    return true
  }

  const api: NavMotionController = {
    press() {
      if (!begin()) return
      autoRelease = null
      model.press()
      wake()
    },
    release() {
      if (destroyed) return
      autoRelease = null
      model.release()
      wake()
    },
    cancel() {
      api.release()
    },
    reverse() {
      if (destroyed) return
      autoRelease = null
      model.reverse()
      wake()
    },
    play() {
      if (!begin()) return
      // 辅助技术触发的激活要用一次真实的短按压：同一瞬间 press+release 会压不出形变
      model.release()
      model.press()
      autoRelease = model.time + 0.085
      wake()
    },
    seek(value: number) {
      if (destroyed) return
      cancelAnimationFrame(frame)
      frame = 0
      autoRelease = null
      preview = true
      render(svg, value, media?.matches)
      svg.dataset.state = 'preview'
      svg.dataset.progress = clamp(value).toFixed(4)
      options.onUpdate?.({ progress: clamp(value), state: 'preview' })
    },
    setRate(value: number) {
      rate = Math.max(0.1, Math.min(4, Number(value) || 1))
    },
    get progress() {
      return model.progress
    },
    get state() {
      return model.state
    },
    destroy() {
      destroyed = true
      cancelAnimationFrame(frame)
      media?.removeEventListener('change', motionChange)
      model.stop()
      draw()
    },
  }

  function motionChange() {
    if (media!.matches) {
      cancelAnimationFrame(frame)
      frame = 0
      autoRelease = null
      model.stop()
      preview = false
    }
    draw()
  }

  media?.addEventListener('change', motionChange)
  draw()
  return api
}

/**
 * 把动效绑到一个交互宿主（通常是按钮）上：宿主内的 `svg[data-icon]` 才是绘制目标。
 * 绑在按钮上是为了键盘、pointer capture、失焦、触摸取消都按按钮的语义走。
 */
export function bind(host: HTMLElement, options: NavMotionOptions = {}): NavMotionController {
  const svg = host.querySelector<SVGSVGElement>('svg[data-icon]')
  if (!svg) throw new Error('NavMotion.bind 需要一个带 data-icon 的内联 <svg>')

  const controller = create(svg, options)
  const abort = new AbortController()
  const opts = { signal: abort.signal }

  let pointer: number | null = null
  let key: string | null = null

  host.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0 || pointer !== null || key) return
    pointer = e.pointerId
    host.setPointerCapture(pointer)
    controller.press()
  }, opts)
  host.addEventListener('pointerup', e => {
    if (e.pointerId !== pointer) return
    pointer = null
    controller.release()
  }, opts)

  const cancel = () => {
    pointer = null
    key = null
    controller.cancel()
  }
  host.addEventListener('pointercancel', cancel, opts)
  host.addEventListener('lostpointercapture', () => {
    if (pointer !== null) cancel()
  }, opts)
  host.addEventListener('keydown', e => {
    if (![' ', 'Enter'].includes(e.key)) return
    if (e.key === ' ') e.preventDefault()
    if (e.repeat || key || pointer !== null) return
    key = e.key
    controller.press()
  }, opts)
  host.addEventListener('keyup', e => {
    if (e.key !== key) return
    e.preventDefault()
    key = null
    controller.release()
    if (e.key === ' ') host.click()
  }, opts)
  host.addEventListener('click', e => {
    // 辅助技术 / 程序化激活（没有 pointer 也没有 key）才补一次演示播放
    if (e.detail === 0 && !key && controller.progress === 0) controller.play()
  }, opts)
  host.addEventListener('blur', cancel, opts)
  window.addEventListener('blur', cancel, opts)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancel()
  }, opts)

  const destroy = controller.destroy
  controller.destroy = () => {
    abort.abort()
    destroy()
  }
  return controller
}
