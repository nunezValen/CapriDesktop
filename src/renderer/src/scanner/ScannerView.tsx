import React, { useState, useEffect, useRef, useCallback } from 'react'
import capriFrameImg from '../assets/capri_frame.png'
import {
  ScannerBounds,
  ScannerScanResult,
  ScannerEventPayload
} from '../../../main/ipc/channels'

type ResizeDirection = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

export const ScannerView: React.FC = () => {
  const [visionMode,setVisionMode]=useState<'cloud'|'local'|'disabled'>('disabled')
  const [localAI, setLocalAI] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [isContinuous, setIsContinuous] = useState(false)
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'result' | 'error'>('idle')
  const [scanResult, setScanResult] = useState<ScannerScanResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: window.innerWidth,
    height: window.innerHeight
  })

  // Refs for smooth drag, resize, and hit-testing
  const boundsRef = useRef<ScannerBounds>({
    x: window.screenX,
    y: window.screenY,
    width: window.innerWidth,
    height: window.innerHeight
  })
  const isDraggingRef = useRef(false)
  const lastIgnoreRef = useRef<boolean | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingBoundsRef = useRef<ScannerBounds | null>(null)
  const resultTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Initial status synchronization and IPC event subscriptions
  useEffect(() => {
    // Sync initial status from main process
    window.api.scanner.getStatus().then((status) => {
      setVisionMode(status.visionMode || 'local')
      setLocalAI(status.localAIEnabled !== false)
      setIsScanning(status.isScanning)
      setIsContinuous(status.isContinuous)
      if (status.bounds) {
        boundsRef.current = { ...status.bounds }
        setDimensions({ width: status.bounds.width, height: status.bounds.height })
      }
    })

    // Listen for scanner events (scanning, result, status, error)
    const unsubscribe = window.api.scanner.onEvent((event: ScannerEventPayload) => {
      if (event.type === 'scanning') {
        setScanState('scanning')
        setIsScanning(true)
        setErrorMessage(null)
        if (resultTimerRef.current) {
          clearTimeout(resultTimerRef.current)
          resultTimerRef.current = null
        }
      } else if (event.type === 'result') {
        setIsScanning(false)
        setScanState('result')
        if (event.result) {
          setScanResult(event.result)
        }
        // Auto-fade tags after 5.5s
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
        resultTimerRef.current = setTimeout(() => {
          setScanState('idle')
        }, 5500)
      } else if (event.type === 'status') {
        if (typeof event.isScanning === 'boolean') setIsScanning(event.isScanning)
        if (typeof event.isContinuous === 'boolean') setIsContinuous(event.isContinuous)
      } else if (event.type === 'error') {
        setIsScanning(false)
        setScanState('error')
        setErrorMessage(event.error || 'Scan failed')
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
        resultTimerRef.current = setTimeout(() => {
          setScanState('idle')
          setErrorMessage(null)
        }, 4000)
      }
    })

    return () => {
      unsubscribe()
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
    }
  }, [])

  // Track window size changes
  useEffect(() => {
    const handleResize = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight })
      boundsRef.current.width = window.innerWidth
      boundsRef.current.height = window.innerHeight
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Batched SetBounds via requestAnimationFrame
  const queueSetBounds = useCallback((nextBounds: ScannerBounds) => {
    pendingBoundsRef.current = nextBounds
    boundsRef.current = nextBounds
    setDimensions({ width: nextBounds.width, height: nextBounds.height })

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        if (pendingBoundsRef.current) {
          window.api.scanner.setBounds(pendingBoundsRef.current)
          pendingBoundsRef.current = null
        }
      })
    }
  }, [])

  // Click-through Hit-Testing (Forward mouse inside the hole; capture on borders/controls)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      if (lastIgnoreRef.current !== false) {
        lastIgnoreRef.current = false
        window.api.scanner.setIgnoreMouse(false)
      }
      return
    }

    const { clientX, clientY } = e
    const w = window.innerWidth
    const h = window.innerHeight

    // Scanner frame interior hole margins (aligns with backend desktopCapturer crop)
    const isInsideHole =
      clientX >= 46 &&
      clientX <= w - 46 &&
      clientY >= 50 &&
      clientY <= h - 48

    if (isInsideHole) {
      if (lastIgnoreRef.current !== true) {
        lastIgnoreRef.current = true
        window.api.scanner.setIgnoreMouse(true)
      }
    } else {
      if (lastIgnoreRef.current !== false) {
        lastIgnoreRef.current = false
        window.api.scanner.setIgnoreMouse(false)
      }
    }
  }, [])

  const handleMouseLeave = useCallback((e: React.MouseEvent) => {
    // On Linux, turning click-through on is reported as the mouse leaving, right where it still is.
    // Answering that would turn it off and on again forever.
    const stillOver = e.clientX > 0 && e.clientY > 0 && e.clientX < window.innerWidth - 1 && e.clientY < window.innerHeight - 1
    if (lastIgnoreRef.current && stillOver && navigator.userAgent.includes('Linux')) return

    if (lastIgnoreRef.current !== false) {
      lastIgnoreRef.current = false
      window.api.scanner.setIgnoreMouse(false)
    }
  }, [])

  // Drag and Resize Handler
  const startDrag = useCallback(
    (direction: ResizeDirection, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()

      isDraggingRef.current = true
      if (lastIgnoreRef.current !== false) {
        lastIgnoreRef.current = false
        window.api.scanner.setIgnoreMouse(false)
      }

      const startMouseX = e.screenX
      const startMouseY = e.screenY
      const startBounds = { ...boundsRef.current }

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.screenX - startMouseX
        const deltaY = moveEvent.screenY - startMouseY

        let nextX = startBounds.x
        let nextY = startBounds.y
        let nextW = startBounds.width
        let nextH = startBounds.height

        const MIN_W = 260
        const MIN_H = 220

        if (direction === 'move') {
          nextX = startBounds.x + deltaX
          nextY = startBounds.y + deltaY
        } else {
          // Horizontal adjustments
          if (direction.includes('e')) {
            nextW = Math.max(MIN_W, startBounds.width + deltaX)
          } else if (direction.includes('w')) {
            const rawW = startBounds.width - deltaX
            nextW = Math.max(MIN_W, rawW)
            nextX = startBounds.x + (startBounds.width - nextW)
          }

          // Vertical adjustments
          if (direction.includes('s')) {
            nextH = Math.max(MIN_H, startBounds.height + deltaY)
          } else if (direction.includes('n')) {
            const rawH = startBounds.height - deltaY
            nextH = Math.max(MIN_H, rawH)
            nextY = startBounds.y + (startBounds.height - nextH)
          }
        }

        queueSetBounds({
          x: Math.round(nextX),
          y: Math.round(nextY),
          width: Math.round(nextW),
          height: Math.round(nextH)
        })
      }

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        isDraggingRef.current = false

        // Ensure final bounds are flushed and saved
        if (pendingBoundsRef.current) {
          window.api.scanner.setBounds(pendingBoundsRef.current)
          pendingBoundsRef.current = null
        }
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [queueSetBounds]
  )

  // Ctrl + Mouse Wheel Zoom Resizing
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()

      const cur = boundsRef.current
      if (!cur.width || !cur.height) return

      // deltaY < 0 = scroll up -> zoom in/enlarge
      // deltaY > 0 = scroll down -> zoom out/shrink
      const step = e.deltaY < 0 ? 32 : -32
      const aspect = cur.width / cur.height
      const nextW = Math.max(260, Math.min(2200, cur.width + step * aspect))
      const nextH = Math.max(220, Math.min(1600, cur.height + step))
      const nextX = cur.x - Math.round((nextW - cur.width) / 2)
      const nextY = cur.y - Math.round((nextH - cur.height) / 2)

      const nextBounds = {
        x: Math.round(nextX),
        y: Math.round(nextY),
        width: Math.round(nextW),
        height: Math.round(nextH)
      }
      queueSetBounds(nextBounds)
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [queueSetBounds])

  // Action Handlers
  const handleTriggerScan = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isScanning) return
    try {
      setIsScanning(true)
      setScanState('scanning')
      await window.api.scanner.scan()
    } catch (err) {
      console.error('[ScannerView] Trigger scan error:', err)
      setIsScanning(false)
    }
  }

  const handleToggleContinuous = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const next = !isContinuous
      if (next && visionMode === 'cloud' && !window.confirm('Enable Live Scan? While this scanner is open, changed frame contents will be sent to your cloud vision provider at most once per minute. Close the scanner or turn Live off to stop. Live stays off after restarting Capri.')) return
      setIsContinuous(await window.api.scanner.setContinuous(next))
    } catch (err) {
      console.error('[ScannerView] Toggle continuous error:', err)
      setIsContinuous(false)
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await window.api.scanner.close()
    } catch (err) {
      console.error('[ScannerView] Close error:', err)
    }
  }

  return (
    <div
      className="fixed inset-0 w-full h-full select-none overflow-hidden bg-transparent"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* 9-Slice Capri Frame Border Layer */}
      <div
        className="absolute inset-0 pointer-events-none transition-all duration-150"
        style={{
          borderStyle: 'solid',
          borderWidth: '48px 45px 48px 45px',
          borderImageSource: `url("${capriFrameImg}")`,
          borderImageSlice: '160 150 160 140',
          borderImageRepeat: 'stretch',
          filter: isScanning
            ? 'drop-shadow(0 0 16px rgba(0, 240, 255, 0.75)) drop-shadow(0 0 24px rgba(255, 0, 128, 0.45))'
            : isContinuous
            ? 'drop-shadow(0 0 12px rgba(16, 185, 129, 0.65)) drop-shadow(0 0 4px rgba(0, 240, 255, 0.4))'
            : 'drop-shadow(0 0 10px rgba(0, 240, 255, 0.45))'
        }}
      />

      {/* Cyberpunk Top Header Bar & Control Buttons */}
      <div
        className="absolute top-1 left-11 right-11 h-10 z-30 flex items-center justify-between px-2 bg-[#090b14]/90 border border-cyan-500/40 rounded shadow-[0_0_15px_rgba(0,240,255,0.25)] backdrop-blur-sm cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => startDrag('move', e)}
        title="Drag to move scanner frame (or use Ctrl + Wheel to resize)"
      >
        {/* Left: Drag Handle & Title */}
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="flex items-center gap-1.5 text-cyan-400 font-mono text-[11px] font-bold tracking-wider">
            <span className="text-cyan-300">☵</span>
            <span className="truncate">SCANNER</span>
          </div>
          <span className="text-[10px] font-mono text-cyan-500/70 border border-cyan-500/30 px-1 py-0.2 rounded bg-cyan-950/30">
            {dimensions.width}×{dimensions.height}
          </span>
        </div>

        {/* Right: Scan, Continuous, & Close Buttons */}
        <div className="flex items-center gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
          <button title="Fit the scanner within this display's usable area" className="px-2 py-1 border border-cyan-500 text-cyan-300 rounded text-[10px] whitespace-nowrap" onClick={async()=>{const b=await window.api.scanner.fitScreen();if(b){boundsRef.current=b;setDimensions({width:b.width,height:b.height})}}}>Fit screen</button>
          {visionMode === 'cloud' && <span className="text-[10px] text-cyan-300 whitespace-nowrap" title="Scans send images to your selected cloud provider; Live requires your confirmation">Cloud vision</span>}
          {!localAI && visionMode !== 'cloud' && <button className="px-2 py-1 border border-amber-500 text-amber-300 rounded text-[10px]" title="Allow local AI models to run again; scanning can use substantial memory" onClick={async()=>setLocalAI(await window.api.scanner.setLocalAIEnabled(true))}>Enable local AI</button>}
          {/* Scan Button */}
          <button
            onClick={handleTriggerScan}
            disabled={isScanning}
            className={`px-2.5 py-1 rounded font-mono text-[11px] font-bold tracking-wide transition-all duration-200 flex items-center gap-1 cursor-pointer ${
              isScanning
                ? 'bg-rose-950/80 border border-rose-400 text-rose-300 animate-pulse shadow-[0_0_12px_rgba(244,63,94,0.5)]'
                : 'bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-400 text-cyan-300 hover:text-white shadow-[0_0_10px_rgba(0,240,255,0.35)] active:scale-95'
            }`}
            title="Scan and show Capri what is inside the frame"
          >
            <span className="text-xs">{isScanning ? '⏳' : '⚡'}</span>
            <span>{isScanning ? 'SCANNING...' : 'SCAN'}</span>
          </button>

          {/* Continuous Mode Toggle */}
          <button
            disabled={visionMode === 'disabled'}
            onClick={handleToggleContinuous}
            className={`px-2 py-1 rounded font-mono text-[10px] font-semibold tracking-wide transition-all duration-200 border cursor-pointer ${
              isContinuous
                ? 'bg-emerald-950/80 border-emerald-400 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.4)]'
                : 'bg-slate-900/80 hover:bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title={visionMode === 'cloud' ? 'Opt-in cloud Live Scan: changed frame contents, at most once per minute while open' : 'Continuous mode: auto-scans when frame content changes'}
          >
            {isContinuous ? '● LIVE ON' : '○ LIVE OFF'}
          </button>

          {/* Close Button */}
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded font-mono text-xs font-bold text-slate-400 hover:text-rose-300 bg-slate-900/80 hover:bg-rose-950/80 border border-slate-700 hover:border-rose-500 transition-colors cursor-pointer"
            title="Close scanner frame"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Frame Decorative Edge Drag Areas (Dragging border moves frame) */}
      <div
        className="absolute top-0 left-12 right-12 h-11 z-20 cursor-move"
        onMouseDown={(e) => startDrag('move', e)}
      />
      <div
        className="absolute bottom-0 left-12 right-12 h-11 z-20 cursor-move"
        onMouseDown={(e) => startDrag('move', e)}
      />
      <div
        className="absolute left-0 top-12 bottom-12 w-11 z-20 cursor-move"
        onMouseDown={(e) => startDrag('move', e)}
      />
      <div
        className="absolute right-0 top-12 bottom-12 w-11 z-20 cursor-move"
        onMouseDown={(e) => startDrag('move', e)}
      />

      {/* 8 Resize Handles */}
      {/* Corners */}
      <div
        className="absolute top-0 left-0 w-8 h-8 z-40 cursor-nwse-resize group"
        onMouseDown={(e) => startDrag('nw', e)}
        title="Resize top-left corner"
      >
        <div className="absolute top-1 left-1 w-2.5 h-2.5 border-t-2 border-l-2 border-cyan-400 opacity-60 group-hover:opacity-100 group-hover:scale-125 transition-all" />
      </div>
      <div
        className="absolute top-0 right-0 w-8 h-8 z-40 cursor-nesw-resize group"
        onMouseDown={(e) => startDrag('ne', e)}
        title="Resize top-right corner"
      >
        <div className="absolute top-1 right-1 w-2.5 h-2.5 border-t-2 border-r-2 border-cyan-400 opacity-60 group-hover:opacity-100 group-hover:scale-125 transition-all" />
      </div>
      <div
        className="absolute bottom-0 left-0 w-8 h-8 z-40 cursor-nesw-resize group"
        onMouseDown={(e) => startDrag('sw', e)}
        title="Resize bottom-left corner"
      >
        <div className="absolute bottom-1 left-1 w-2.5 h-2.5 border-b-2 border-l-2 border-cyan-400 opacity-60 group-hover:opacity-100 group-hover:scale-125 transition-all" />
      </div>
      <div
        className="absolute bottom-0 right-0 w-8 h-8 z-40 cursor-nwse-resize group"
        onMouseDown={(e) => startDrag('se', e)}
        title="Resize bottom-right corner"
      >
        <div className="absolute bottom-1 right-1 w-2.5 h-2.5 border-b-2 border-r-2 border-cyan-400 opacity-60 group-hover:opacity-100 group-hover:scale-125 transition-all" />
      </div>

      {/* Edges */}
      <div
        className="absolute top-0 left-8 right-8 h-2 z-40 cursor-ns-resize"
        onMouseDown={(e) => startDrag('n', e)}
      />
      <div
        className="absolute bottom-0 left-8 right-8 h-2 z-40 cursor-ns-resize"
        onMouseDown={(e) => startDrag('s', e)}
      />
      <div
        className="absolute left-0 top-8 bottom-8 w-2 z-40 cursor-ew-resize"
        onMouseDown={(e) => startDrag('w', e)}
      />
      <div
        className="absolute right-0 top-8 bottom-8 w-2 z-40 cursor-ew-resize"
        onMouseDown={(e) => startDrag('e', e)}
      />

      {/* interior scanning & HUD overlay layer (Always pointer-events-none for click-through) */}
      <div
        className="absolute top-[48px] bottom-[48px] left-[45px] right-[45px] overflow-hidden pointer-events-none z-10"
      >
        {/* Subtle Cyberpunk HUD Corner Brackets in Idle */}
        <div className="absolute top-2 left-2 w-4 h-4 border-t border-l border-cyan-400/40" />
        <div className="absolute top-2 right-2 w-4 h-4 border-t border-r border-cyan-400/40" />
        <div className="absolute bottom-2 left-2 w-4 h-4 border-b border-l border-cyan-400/40" />
        <div className="absolute bottom-2 right-2 w-4 h-4 border-b border-r border-cyan-400/40" />

        {/* Center Reticle Crosshair */}
        <div className="absolute inset-0 flex items-center justify-center opacity-25">
          <div className="w-8 h-8 relative">
            <div className="absolute top-1/2 left-0 right-0 h-px bg-cyan-400" />
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-cyan-400" />
            <div className="absolute inset-1 rounded-full border border-cyan-400/50" />
          </div>
        </div>

        {/* Idle / Live Telemetry Indicator */}
        <div className="absolute bottom-2 right-3 font-mono text-[9px] text-cyan-400/60 tracking-wider flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isContinuous ? 'bg-emerald-400 animate-ping' : 'bg-cyan-400/70'}`} />
          <span>{isContinuous ? 'LIVE FEED MONITORING' : 'OPTICAL_FEED: STANDBY'}</span>
        </div>

        {/* scanning state: Neon Laser Sweep & Holographic Grid */}
        {scanState === 'scanning' && (
          <div className="absolute inset-0">
            {/* Holographic Matrix Grid */}
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundImage:
                  'linear-gradient(to right, rgba(0, 240, 255, 0.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(0, 240, 255, 0.25) 1px, transparent 1px)',
                backgroundSize: '24px 24px'
              }}
            />

            {/* Neon Glitch Horizontal Flickers */}
            <div className="absolute top-1/4 left-0 right-0 h-0.5 bg-cyan-400/30 animate-pulse" />
            <div className="absolute top-2/3 left-0 right-0 h-0.5 bg-rose-400/30 animate-pulse" />

            {/* Sweeping Laser Beam & Glowing Trail */}
            <div
              className="absolute left-0 right-0 h-1 z-10"
              style={{
                animation: 'scanSweep 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite',
                background:
                  'linear-gradient(90deg, transparent 0%, #00f0ff 25%, #ffffff 50%, #ff007f 75%, transparent 100%)',
                boxShadow:
                  '0 0 15px #00f0ff, 0 0 30px #ff007f, 0 0 45px rgba(0, 240, 255, 0.8)'
              }}
            >
              {/* Trailing vertical gradient light wash */}
              <div
                className="w-full h-24 -mt-24 pointer-events-none"
                style={{
                  background:
                    'linear-gradient(180deg, transparent 0%, rgba(0, 240, 255, 0.15) 70%, rgba(255, 0, 128, 0.25) 100%)'
                }}
              />
            </div>

            {/* Telemetry Readout */}
            <div className="absolute top-3 left-3 font-mono text-[10px] text-cyan-300 font-bold bg-[#090b14]/85 px-2 py-1 rounded border border-cyan-400/40 shadow-[0_0_10px_rgba(0,240,255,0.3)] animate-pulse">
              &gt; ACQUIRING OPTICAL BUFFER // NEURAL INFERENCE...
            </div>
          </div>
        )}

        {/* result state: Floating Cyberpunk HUD Tags & Summary */}
        {scanState === 'result' && scanResult && (
          <div className="absolute inset-0 flex flex-col justify-between p-3 animate-fade-in">
            {/* Top: Recognized Feature Tags */}
            <div className="flex flex-wrap gap-1.5 max-w-full">
              {(scanResult.tags || []).map((tag, idx) => (
                <div
                  key={idx}
                  className="px-2 py-0.5 rounded font-mono text-[10px] font-bold text-cyan-300 bg-[#090b14]/90 border border-cyan-400/70 shadow-[0_0_8px_rgba(0,240,255,0.4)] flex items-center gap-1"
                >
                  <span className="text-cyan-400 text-[8px]">◈</span>
                  <span>{tag}</span>
                </div>
              ))}
            </div>

            {/* Bottom: Target Summary & Capri Reaction Chip */}
            <div className="flex flex-col gap-1 max-w-full">
              {scanResult.summary && (
                <div className="font-mono text-[10px] text-slate-200 bg-[#090b14]/90 px-2 py-1 rounded border border-cyan-500/40 shadow-[0_0_10px_rgba(0,240,255,0.25)] flex items-center gap-1.5 truncate">
                  <span className="text-cyan-400 font-bold">TARGET:</span>
                  <span className="truncate">{scanResult.summary}</span>
                </div>
              )}
              {scanResult.response && (
                <div className="font-mono text-[11px] text-emerald-300 bg-[#090b14]/95 px-2.5 py-1.5 rounded border border-emerald-400/60 shadow-[0_0_12px_rgba(16,185,129,0.3)] leading-tight">
                  <span className="text-cyan-400 font-bold mr-1">CAPRI:</span>
                  <span>&ldquo;{scanResult.response}&rdquo;</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* error state: Friendly Warning */}
        {scanState === 'error' && errorMessage && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="bg-[#1a0a14]/95 border border-rose-500/70 text-rose-300 font-mono text-xs px-3 py-2 rounded shadow-[0_0_15px_rgba(244,63,94,0.4)] text-center max-w-md">
              <div className="font-bold text-rose-400 mb-0.5">⚠️ OPTICAL SCANNER GLITCH</div>
              <div className="text-[11px] leading-snug">{errorMessage}</div>
            </div>
          </div>
        )}
      </div>

      {/* Global CSS Animation for Scanner Sweep */}
      <style>{`
        @keyframes scanSweep {
          0% {
            top: 0%;
            opacity: 0.9;
          }
          50% {
            opacity: 1;
          }
          100% {
            top: 100%;
            opacity: 0.8;
          }
        }
      `}</style>
    </div>
  )
}

export default ScannerView
