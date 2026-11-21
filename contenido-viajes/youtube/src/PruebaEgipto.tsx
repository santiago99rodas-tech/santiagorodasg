import React from 'react';
import {AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {Mascota} from './Mascota';

const FONT = "'Inter', 'Inter Display', sans-serif";
const ACENTO = '#FFD54A';
const OSCURO = '#2B1A12';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

// ------------------------------------------------------------ subtítulos
// Cada palabra con el cuadro en que se dice. En el video real salen de la
// transcripción de la voz de Santiago; aquí van escritos a mano.
type Palabra = {w: string; f: number; clave?: boolean};
const GUION: Palabra[][] = [
  [{w: 'Así', f: 6}, {w: 'llegué', f: 14}, {w: 'a', f: 24}, {w: 'las', f: 28}, {w: 'pirámides', f: 34, clave: true}],
  [{w: 'y', f: 80}, {w: 'nadie', f: 88}, {w: 'me', f: 98}, {w: 'avisó', f: 104}, {w: 'esto', f: 116, clave: true}],
  [{w: 'Mi', f: 160}, {w: 'ruta:', f: 168}, {w: 'El', f: 182}, {w: 'Cairo,', f: 188, clave: true}],
  [{w: 'Asuán', f: 214, clave: true}, {w: 'y', f: 240}, {w: 'Luxor', f: 252, clave: true}, {w: 'en', f: 266}, {w: 'barco', f: 272}],
  [{w: 'Hay', f: 306}, {w: 'tres', f: 314, clave: true}, {w: 'boletos', f: 322}, {w: 'distintos', f: 336}],
  [{w: 'y', f: 372}, {w: 'casi', f: 378}, {w: 'todos', f: 386}, {w: 'compran', f: 394}, {w: 'el', f: 404}, {w: 'equivocado', f: 408, clave: true}],
  [{w: 'Y', f: 428}, {w: 'esta', f: 434}, {w: 'es', f: 442}, {w: 'la', f: 446}, {w: 'foto', f: 452}, {w: 'real', f: 462, clave: true}],
];

const Subtitulos: React.FC = () => {
  const frame = useCurrentFrame();
  const idx = GUION.findIndex((frase, i) => {
    const sig = GUION[i + 1];
    return frame >= frase[0].f && (!sig || frame < sig[0].f);
  });
  if (idx < 0) return null;
  const frase = GUION[idx];
  return (
    <div style={{position: 'absolute', top: 70, width: '100%', display: 'flex', justifyContent: 'center', gap: 22}}>
      {frase.map((p, i) => {
        if (frame < p.f) return null;
        const pop = interpolate(frame - p.f, [0, 5], [0.6, 1], clamp);
        const activa = frase[i + 1] ? frame < frase[i + 1].f : true;
        return (
          <span
            key={i}
            style={{
              fontFamily: FONT,
              fontWeight: 800,
              fontSize: 64,
              color: p.clave ? ACENTO : 'white',
              transform: `scale(${pop})`,
              textShadow: '0 4px 14px rgba(0,0,0,0.35)',
              WebkitTextStroke: '10px #2B1A12',
              paintOrder: 'stroke fill',
              position: 'relative',
              padding: '0 10px',
              opacity: activa || !p.clave ? 1 : 0.95,
            }}
          >
            {p.clave && (
              // marco de esquinas, como en la referencia
              <svg style={{position: 'absolute', inset: -6, width: 'calc(100% + 12px)', height: 'calc(100% + 12px)'}} preserveAspectRatio="none" viewBox="0 0 100 100">
                {[
                  'M0 22 L0 0 L14 0',
                  'M86 0 L100 0 L100 22',
                  'M0 78 L0 100 L14 100',
                  'M86 100 L100 100 L100 78',
                ].map((d) => (
                  <path key={d} d={d} stroke={ACENTO} strokeWidth="5" fill="none" vectorEffect="non-scaling-stroke" />
                ))}
              </svg>
            )}
            {p.w}
          </span>
        );
      })}
    </div>
  );
};

// ------------------------------------------------------------ escena 1: desierto
const Piramide: React.FC<{x: number; base: number; alto: number}> = ({x, base, alto}) => (
  <g>
    <polygon points={`${x},${780 - alto} ${x - base / 2},780 ${x + base / 2},780`} fill="#E8B266" />
    <polygon points={`${x},${780 - alto} ${x},780 ${x + base / 2},780`} fill="#C98F45" />
    {Array.from({length: 6}).map((_, k) => {
      const y = 780 - (alto * (k + 1)) / 7;
      const half = (base / 2) * (1 - (k + 1) / 7);
      return <line key={k} x1={x - half} y1={y} x2={x + half} y2={y} stroke="#B07A38" strokeWidth="2" opacity="0.35" />;
    })}
  </g>
);

const Desierto: React.FC = () => {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, 150], [1, 1.18], {easing: Easing.inOut(Easing.cubic), ...clamp});
  const camX = interpolate(frame, [0, 150], [0, -90], clamp);
  const mascX = interpolate(frame, [10, 100], [-260, 640], {easing: Easing.out(Easing.quad), ...clamp});
  const caminando = frame > 10 && frame < 100;
  const sorprendido = frame > 112;
  const bang = spring({frame: frame - 112, fps: 30, config: {damping: 9}});
  return (
    <AbsoluteFill style={{background: 'linear-gradient(#FBD38D, #F6A86A 70%)', overflow: 'hidden'}}>
      <AbsoluteFill style={{transform: `translateX(${camX}px) scale(${zoom})`, transformOrigin: '60% 70%'}}>
        <svg width="1920" height="1080" viewBox="0 0 1920 1080">
          <circle cx="1500" cy="250" r="110" fill="#FFE7A3" />
          <circle cx="1500" cy="250" r="150" fill="#FFE7A3" opacity="0.3" />
          {[0, 1, 2].map((k) => {
            const x = ((frame * (0.6 + k * 0.2) + k * 700) % 2300) - 200;
            return (
              <g key={k} transform={`translate(${x} ${140 + k * 70})`} opacity="0.85">
                <ellipse cx="0" cy="0" rx="90" ry="26" fill="white" />
                <ellipse cx="50" cy="-14" rx="60" ry="26" fill="white" />
              </g>
            );
          })}
          <Piramide x={1150} base={620} alto={430} />
          <Piramide x={1520} base={420} alto={290} />
          <Piramide x={830} base={300} alto={200} />
          <path d="M0 760 Q300 700 640 770 T1300 760 T1920 750 L1920 1080 L0 1080 Z" fill="#F0C27B" />
          <path d="M0 860 Q400 800 900 870 T1920 850 L1920 1080 L0 1080 Z" fill="#E6AE62" />
          {/* palmera */}
          <g transform="translate(260 650)">
            <path d="M0 220 Q10 110 -6 0" stroke="#8A5A2B" strokeWidth="18" fill="none" />
            {[-60, -20, 20, 60, 100].map((a) => (
              <ellipse key={a} cx="0" cy="0" rx="90" ry="20" fill="#3E9B5B" transform={`rotate(${a + Math.sin(frame / 20) * 4}) translate(70 0)`} />
            ))}
          </g>
        </svg>
        <div style={{position: 'absolute', left: mascX, top: 600}}>
          <Mascota frame={frame} caminando={caminando} sorprendido={sorprendido} size={240} />
          {sorprendido && (
            <div style={{position: 'absolute', left: 170, top: -30, transform: `scale(${bang})`, fontFamily: FONT, fontWeight: 900, fontSize: 110, color: '#E2412F'}}>
              !
            </div>
          )}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------ escena 2: mapa
const Mapa: React.FC = () => {
  const frame = useCurrentFrame();
  const pin = (start: number) => spring({frame: frame - start, fps: 30, config: {damping: 10}});
  const vuelo = interpolate(frame, [64, 100], [0, 1], {easing: Easing.inOut(Easing.cubic), ...clamp});
  const barco = interpolate(frame, [100, 140], [0, 1], {easing: Easing.inOut(Easing.quad), ...clamp});
  const zoom = interpolate(frame, [0, 150], [1, 1.08], clamp);
  // Arco del avión El Cairo -> Asuán (curva cuadrática)
  const P0 = [430, 190], C = [700, 360], P1 = [520, 610];
  const bez = (t: number) => [
    (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * C[0] + t * t * P1[0],
    (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * C[1] + t * t * P1[1],
  ];
  const [ax, ay] = bez(vuelo);
  const by = interpolate(barco, [0, 1], [610, 500]);
  const bx = interpolate(barco, [0, 1], [520, 505]);
  const ciudad = (x: number, y: number, n: string, s: number, ladoIzq = false) => (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path d="M0 0 C-22 -30 -22 -54 0 -54 C22 -54 22 -30 0 0 Z" fill="#E2412F" />
      <circle cx="0" cy="-36" r="8" fill="white" />
      <text x={ladoIzq ? -34 : 34} y="-26" textAnchor={ladoIzq ? 'end' : 'start'} fontFamily={FONT} fontWeight={800} fontSize="34" fill={OSCURO}>
        {n}
      </text>
    </g>
  );
  return (
    <AbsoluteFill style={{background: '#7EC8E3'}}>
      <AbsoluteFill style={{transform: `scale(${zoom})`}}>
        <svg width="1920" height="1080" viewBox="-480 -60 1700 956" style={{position: 'absolute'}}>
          <polygon points="40,110 250,90 400,105 530,130 560,170 640,380 720,560 760,700 40,700" fill="#F3D9A4" stroke="#D9B46C" strokeWidth="6" strokeLinejoin="round" />
          <polygon points="580,150 700,130 690,180 620,330 590,210" fill="#F3D9A4" stroke="#D9B46C" strokeWidth="6" strokeLinejoin="round" />
          <text x="150" y="420" fontFamily={FONT} fontWeight={900} fontSize="70" fill="#D9B46C" opacity="0.7">EGIPTO</text>
          {/* Nilo */}
          <path d="M400 112 Q420 150 430 190 Q470 300 455 380 Q500 450 505 500 Q530 560 520 610 L525 700" stroke="#3A8FD0" strokeWidth="12" fill="none" strokeLinecap="round" />
          {/* ruta del avión */}
          <path
            d={`M${P0[0]} ${P0[1]} Q${C[0]} ${C[1]} ${P1[0]} ${P1[1]}`}
            stroke={OSCURO}
            strokeWidth="5"
            strokeDasharray="14 12"
            fill="none"
            opacity={vuelo > 0 ? 1 : 0}
            mask="url(#m)"
          />
          <defs>
            <mask id="m">
              <path d={`M${P0[0]} ${P0[1]} Q${C[0]} ${C[1]} ${P1[0]} ${P1[1]}`} stroke="white" strokeWidth="14" fill="none" pathLength={1} strokeDasharray={`${vuelo} 1`} />
            </mask>
          </defs>
          {vuelo > 0 && vuelo < 1 && (
            <g transform={`translate(${ax} ${ay}) rotate(${interpolate(vuelo, [0, 1], [40, 150])})`}>
              <path d="M-26 0 L26 0 M0 0 L-12 -24 M0 0 L-12 24 M-22 0 L-30 -10 M-22 0 L-30 10" stroke={OSCURO} strokeWidth="9" strokeLinecap="round" />
            </g>
          )}
          {barco > 0 && (
            <g transform={`translate(${bx} ${by})`}>
              <path d="M-26 0 L26 0 L18 14 L-18 14 Z" fill="white" stroke={OSCURO} strokeWidth="3" />
              <path d="M0 0 L0 -36 L22 -6 Z" fill="white" stroke={OSCURO} strokeWidth="3" />
            </g>
          )}
          {ciudad(430, 190, 'El Cairo', pin(20), true)}
          {ciudad(505, 500, 'Luxor', pin(100), true)}
          {ciudad(520, 610, 'Asuán', pin(60))}
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------ escena 3: boletos
const Boletos: React.FC = () => {
  const frame = useCurrentFrame();
  const items = [
    {t: 'Entrada general', n: 1, color: '#2BB3A3'},
    {t: 'Interior de la Gran Pirámide', n: 2, color: '#F28C38'},
    {t: 'Combo con museo', n: 3, color: '#7B61FF'},
  ];
  return (
    <AbsoluteFill style={{background: '#FFF4DE'}}>
      <div style={{position: 'absolute', top: 260, width: '100%', display: 'flex', justifyContent: 'center', gap: 60}}>
        {items.map((it, i) => {
          const s = spring({frame: frame - 10 - i * 12, fps: 30, config: {damping: 11}});
          const tachado = i !== 1 && frame > 80;
          const elegido = i === 1 && frame > 80;
          return (
            <div
              key={i}
              style={{
                width: 420,
                height: 300,
                borderRadius: 28,
                background: 'white',
                boxShadow: '0 18px 40px rgba(43,26,18,0.15)',
                transform: `scale(${s * (elegido ? 1.08 : 1)}) rotate(${(i - 1) * 3}deg)`,
                border: `8px solid ${it.color}`,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                position: 'relative',
                opacity: tachado ? 0.45 : 1,
              }}
            >
              <div style={{fontFamily: FONT, fontWeight: 900, fontSize: 96, color: it.color}}>#{it.n}</div>
              <div style={{fontFamily: FONT, fontWeight: 700, fontSize: 34, color: OSCURO, textAlign: 'center', padding: '0 24px'}}>{it.t}</div>
              {tachado && (
                <svg style={{position: 'absolute', inset: 0}} viewBox="0 0 420 300">
                  <line x1="40" y1="40" x2={40 + 340 * interpolate(frame, [80, 92], [0, 1], clamp)} y2={40 + 220 * interpolate(frame, [80, 92], [0, 1], clamp)} stroke="#E2412F" strokeWidth="14" strokeLinecap="round" />
                </svg>
              )}
              {elegido && (
                <div style={{position: 'absolute', top: -40, right: -30, background: ACENTO, borderRadius: 16, padding: '8px 18px', fontFamily: FONT, fontWeight: 900, fontSize: 32, color: OSCURO, transform: `rotate(8deg) scale(${spring({frame: frame - 84, fps: 30})})`}}>
                  EL QUE VALE
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{position: 'absolute', left: 140, top: 600}}>
        <Mascota frame={frame} senalando={frame > 80} size={300} />
      </div>
      <div style={{position: 'absolute', bottom: 30, right: 40, fontFamily: FONT, fontSize: 24, color: OSCURO, opacity: 0.5}}>
        prueba de estilo · contenido de ejemplo
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------ escena 4: foto real
const FotoReal: React.FC = () => {
  const frame = useCurrentFrame();
  const entra = spring({frame: frame - 6, fps: 30, config: {damping: 13}});
  const flash = interpolate(frame, [40, 44, 56], [0, 1, 0], clamp);
  return (
    <AbsoluteFill style={{background: 'linear-gradient(#FBD38D, #F6A86A)'}}>
      <div
        style={{
          position: 'absolute',
          left: 820,
          top: 170,
          width: 760,
          height: 780,
          background: 'white',
          padding: 30,
          paddingBottom: 120,
          boxShadow: '0 30px 60px rgba(0,0,0,0.25)',
          transform: `translateY(${(1 - entra) * 900}px) rotate(${-4 + (1 - entra) * 20}deg)`,
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'repeating-linear-gradient(45deg, #d9cbb5 0 30px, #e6dac6 30px 60px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONT,
            fontWeight: 900,
            fontSize: 48,
            color: OSCURO,
            textAlign: 'center',
          }}
        >
          AQUÍ VA TU FOTO
          <br />O VIDEO REAL
        </div>
        <div style={{position: 'absolute', bottom: 34, width: '100%', left: 0, textAlign: 'center', fontFamily: "'Liberation Serif', serif", fontStyle: 'italic', fontSize: 52, color: OSCURO}}>
          Giza, Egipto
        </div>
      </div>
      <div style={{position: 'absolute', left: 280, top: 560}}>
        <Mascota frame={frame} camara flash={flash} size={260} />
      </div>
      <AbsoluteFill style={{background: 'white', opacity: flash * 0.6}} />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------ transición
const Transicion: React.FC<{children: React.ReactNode; dur: number}> = ({children, dur}) => {
  const frame = useCurrentFrame();
  const entrada = interpolate(frame, [0, 8], [0, 1], clamp);
  const salida = interpolate(frame, [dur - 8, dur], [1, 0], clamp);
  const escala = interpolate(frame, [dur - 8, dur], [1, 1.25], clamp);
  return <AbsoluteFill style={{opacity: Math.min(entrada, salida), transform: `scale(${escala})`}}>{children}</AbsoluteFill>;
};

export const PruebaEgipto: React.FC = () => {
  const {durationInFrames} = useVideoConfig();
  const escenas: [number, number, React.FC][] = [
    [0, 150, Desierto],
    [150, 150, Mapa],
    [300, 120, Boletos],
    [420, durationInFrames - 420, FotoReal],
  ];
  return (
    <AbsoluteFill style={{background: OSCURO}}>
      {escenas.map(([desde, dur, Escena]) => (
        <Sequence key={desde} from={desde} durationInFrames={dur}>
          <Transicion dur={desde + dur >= durationInFrames ? 9999 : dur}>
            <Escena />
          </Transicion>
        </Sequence>
      ))}
      <Subtitulos />
    </AbsoluteFill>
  );
};
