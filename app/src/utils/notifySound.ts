/**
 * 通知提示音：使用 Web Audio API 合成柔和的双音「叮咚」，无需打包音频资源，
 * 也不依赖操作系统默认通知音。无论窗口是否聚焦都能播放（需曾被用户交互过）。
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || (window as any).webkitAudioContext
  if (!AC) return null
  if (!ctx) {
    try {
      ctx = new AC()
    } catch {
      return null
    }
  }
  return ctx
}

/**
 * 播放通知提示音（柔和渐隐的双音）。
 * @param freqs 欲依次播放的频率序列，默认「 alto → 高八度」的叮咚效果
 */
export function playNotificationSound(freqs: number[] = [660, 880]) {
  const audio = getCtx()
  if (!audio) return
  // 部分浏览器要求 resume 以解除自动播放限制
  if (audio.state === 'suspended') void audio.resume()

  const now = audio.currentTime
  freqs.forEach((freq, i) => {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    const start = now + i * 0.16
    const dur = 0.18
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, start)
    // 轻微淡入淡出，避免爆音
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start(start)
    osc.stop(start + dur + 0.02)
  })
}
