import React from 'react';
import {AbsoluteFill, Img, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {Santi, Expresion, POSES} from '../santi/Santi';
import {
  Boleto, Caja, Contador, F, FondoDuomo, FondoVenecia, FotoReal, Grano, MapaItalia, PAL, QR, Sello, Texto, Velo, entra, pop, s2f, useFuentes,
} from '../piezas';
import {PALABRAS} from './palabras';

// Prototipo de 1 minuto: Milán → Venecia (guiones/milan-venecia-youtube-1min.md).
// Tiempos en segundos sobre la voz final (voz pulida + firma "Nos vemos pues").
export const DURACION_S = 70.6;

const habla = (t: number) => PALABRAS.some(([a, b]) => t >= a - 0.03 && t <= b + 0.03);

// escena con entrada suave (fundido + leve zoom) para unir una con otra
const Escena: React.FC<{desde: number; hasta: number; children: (f: number, t0: number) => React.ReactNode}> = ({desde, hasta, children}) => {
  const a = s2f(desde), d = s2f(hasta) - a;
  return (
    <Sequence from={a} durationInFrames={d}>
      <Interior t0={desde} dur={d}>{children}</Interior>
    </Sequence>
  );
};
const Interior: React.FC<{t0: number; dur: number; children: (f: number, t0: number) => React.ReactNode}> = ({t0, children}) => {
  const f = useCurrentFrame();
  const op = interpolate(f, [0, 6], [0, 1], {extrapolateRight: 'clamp'});
  const z = interpolate(f, [0, 8], [1.035, 1], {extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{opacity: op, transform: `scale(${z})`}}>{children(f, t0)}</AbsoluteFill>;
};

// Santi anclado por los pies
const SantiEn: React.FC<{f: number; t0: number; x: number; y?: number; alto?: number; pose: keyof typeof POSES; desdePose?: keyof typeof POSES; expr: Expresion;
  caminando?: boolean; espejo?: boolean; giro?: number; entraDesde?: number}> = ({f, t0, x, y = 1050, alto = 760, entraDesde = 0, ...p}) => {
  const e = pop(f, 30, entraDesde);
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -100%) translateY(${(1 - Math.min(1, e)) * 120}px)`, opacity: Math.min(1, e * 1.5)}}>
      <Santi frame={f} habla={habla(t0 + f / 30)} alto={alto} {...p} />
    </div>
  );
};

// a partir de qué cuadro de la escena (t absoluto en s)
const k = (t: number, t0: number) => s2f(t - t0);

export const MilanVenecia: React.FC = () => {
  useFuentes();
  const fg = useCurrentFrame();
  return (
    <AbsoluteFill style={{background: PAL.papel}}>
      {/* 1. REAL: Venecia en 2023, entrar era gratis */}
      <Escena desde={0} hasta={3.3}>{(f, t0) => <>
        <FotoReal f={f} dur={100} src="milan/f19.jpg" foco={[50, 62]} zoom={[1.0, 1.12]} />
        <Velo y={200} alto={300} op={0.35} />
        <Texto f={f} desde={2} x={960} y={150} tam={110} color="#fff" entrada="sube">VENECIA · 2023</Texto>
        <Sello f={f} desde={k(2.6, t0)} x={1480} y={760} texto="GRATIS" sub="ENTRADA · SEP 2023" color={PAL.italiaVerde} giro={-9} ancho={380} />
      </>}</Escena>

      {/* 2. ANIM: hoy te cobran hasta 10 € */}
      <Escena desde={3.3} hasta={9.2}>{(f, t0) => <>
        <FondoVenecia f={f} />
        <Texto f={f} desde={2} x={1240} y={150} tam={120} entrada="golpe">HOY</Texto>
        <Texto f={f} desde={k(4.16, t0)} x={1240} y={250} tam={52} fuente="playfair" entrada="sube">si llegas solo por el día…</Texto>
        <Boleto f={f} desde={k(5.98, t0)} x={1240} y={500} titulo="TASA DE ENTRADA" precio={`${Math.round(10 * (1 - Math.pow(1 - entra(f, k(7.0, t0), 10), 3)))} €`} nota="Venecia · visitantes de un día" color={PAL.rojo} giro={-3} />
        <Caja f={f} desde={k(8.6, t0)} x={1240} y={760} tam={70}>SOLO POR ENTRAR</Caja>
        <SantiEn f={f} t0={t0} x={430} pose="bolsillos" expr={f < k(7.1, t0) ? 'neutral' : 'sorpresa'} />
      </>}</Escena>

      {/* 3. ANIM: mapa 48 h en tren */}
      <Escena desde={9.2} hasta={16.7}>{(f, t0) => <>
        <MapaItalia f={f} pinMilan={k(10.0, t0)} pinVenecia={k(10.9, t0)} ruta={entra(f, k(13.4, t0), 24)} tren={f > k(13.4, t0) ? entra(f, k(13.4, t0), 40) : -1} />
        <div style={{position: 'absolute', left: 1500, top: 230, transform: `translate(-50%,-50%) scale(${pop(f, 30, k(11.7, t0))})`, width: 260, height: 260, borderRadius: 130,
          background: PAL.amarillo, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column'}}>
          {f >= k(11.7, t0) && <><div style={{fontFamily: F.bebas, fontSize: 130, lineHeight: 0.9, color: PAL.tinta}}>48</div><div style={{fontFamily: F.bebas, fontSize: 52, color: PAL.tinta}}>HORAS</div></>}
        </div>
        <Caja f={f} desde={k(15.2, t0)} x={960} y={930} tam={84} fondo={PAL.tinta} color="#fff">SIN PAGAR DE MÁS</Caja>
        <SantiEn f={f} t0={t0} x={300} alto={700} pose="senala" desdePose="bolsillos" expr="sonrisa" />
      </>}</Escena>

      {/* 4. REAL: Día 1, Milán */}
      <Escena desde={16.7} hasta={19.7}>{(f, t0) => <>
        <FotoReal f={f} dur={90} src="milan/f07.jpg" foco={[40, 50]} zoom={[1.02, 1.1]} panX={-40} />
        <Velo y={150} alto={260} op={0.35} />
        <Texto f={f} desde={k(16.84, t0)} x={960} y={130} tam={120} color="#fff" entrada="golpe">DÍA 1</Texto>
        <Sello f={f} desde={k(17.6, t0)} x={1540} y={800} texto="MILÁN" sub="ITALIA · SEP 2023" color={PAL.italiaVerde} giro={8} ancho={360} />
      </>}</Escena>

      {/* 5. ANIM: el Duomo se construye: casi 600 años, más de 3.000 estatuas */}
      <Escena desde={19.7} hasta={24.6}>{(f, t0) => <>
        <FondoDuomo f={f} progreso={entra(f, 0, 75)} />
        <Contador f={f} desde={2} de={1386} a={1965} dur={40} x={360} y={260} tam={150} sinMiles />
        <Texto f={f} desde={6} x={360} y={360} tam={40} fuente="mont" color="#7A6A5C">DE 1386 A 1965</Texto>
        <Caja f={f} desde={k(20.5, t0)} x={360} y={480} tam={96} giro={-3}>CASI 600 AÑOS</Caja>
        <Texto f={f} desde={k(23.2, t0)} x={360} y={640} tam={110} entrada="golpe">+3.000</Texto>
        <Texto f={f} desde={k(23.5, t0)} x={360} y={725} tam={56} fuente="playfair">estatuas</Texto>
        <SantiEn f={f} t0={t0} x={1760} alto={660} pose="bolsillos" expr={f > k(20.5, t0) ? 'sorpresa' : 'neutral'} espejo />
      </>}</Escena>

      {/* 6a. REAL: la Galería */}
      <Escena desde={24.6} hasta={27.6}>{(f) => <>
        <FotoReal f={f} dur={90} src="milan/f26.jpg" foco={[50, 40]} zoom={[1.0, 1.12]} />
        <Velo y={960} alto={220} op={0.4} />
        <Texto f={f} desde={6} x={960} y={960} tam={72} fuente="playfair" color="#fff" entrada="sube">Galería Vittorio Emanuele II</Texto>
      </>}</Escena>

      {/* 6b. ANIM: el toro, 3 vueltas = vuelves */}
      <Escena desde={27.6} hasta={32.6}>{(f, t0) => {
        const v0 = k(28.6, t0), giro = f > v0 && f < v0 + 45 ? Math.cos(((f - v0) / 15) * Math.PI * 2) : 1;
        const vuelta = Math.min(3, Math.max(0, Math.floor((f - v0) / 15) + 1));
        return <>
          <AbsoluteFill style={{background: PAL.papel2}} />
          <svg width="1920" height="1080" style={{position: 'absolute'}}>
            <circle cx="960" cy="900" r="330" fill="#D9C3A3" />
            {Array.from({length: 48}, (_, i) => <rect key={i} x={960 + Math.cos(i / 7.6) * 300 - 9} y={900 + Math.sin(i / 7.6) * 300 * 0.35 - 9} width="18" height="18" fill={i % 2 ? '#B99A74' : '#E9DCC8'} />)}
            <ellipse cx="960" cy="900" rx="300" ry="105" fill="none" stroke="#B99A74" strokeWidth="10" />
            <g transform="translate(960 880)" fill={PAL.rojo}>
              <ellipse cx="0" cy="0" rx="120" ry="42" /><ellipse cx="120" cy="-24" rx="40" ry="30" />
              <path d="M140 -48 Q170 -90 196 -76 Q170 -70 156 -40 Z" /><path d="M110 -50 Q100 -96 72 -86 Q98 -76 100 -46 Z" />
              <rect x="-90" y="20" width="18" height="54" /><rect x="-40" y="20" width="18" height="54" /><rect x="40" y="20" width="18" height="54" /><rect x="80" y="20" width="18" height="54" />
            </g>
          </svg>
          <SantiEn f={f} t0={t0} x={960} y={940} alto={700} pose={vuelta > 0 && f < v0 + 45 ? 'brazosArriba' : 'bolsillos'} expr={f > v0 ? 'risa' : 'sonrisa'} giro={giro} />
          {vuelta > 0 && <Texto f={f} desde={v0} x={1560} y={360} tam={300} color={PAL.rojo} entrada="pop">{vuelta}</Texto>}
          <Texto f={f} desde={2} x={960} y={110} tam={86}>UN TORO EN EL PISO</Texto>
          <Caja f={f} desde={k(30.5, t0)} x={420} y={330} tam={82} giro={-4}>3 VUELTAS = VUELVES</Caja>
        </>;
      }}</Escena>

      {/* 7. ANIM: Día 2, tren a Venecia, 2 h 30 */}
      <Escena desde={32.6} hasta={36.1}>{(f, t0) => <>
        <MapaItalia f={f} pinMilan={0} pinVenecia={0} ruta={1} tren={entra(f, 4, 80)} />
        <Texto f={f} desde={k(32.78, t0)} x={960} y={130} tam={110} entrada="golpe">DÍA 2</Texto>
        <Caja f={f} desde={k(34.8, t0)} x={1000} y={760} tam={110} giro={-3}>2 H 30 EN TREN</Caja>
        <SantiEn f={f} t0={t0} x={interpolate(f, [0, 105], [140, 420])} alto={640} pose="camina" expr="sonrisa" caminando />
      </>}</Escena>

      {/* 8. ANIM: compra con tiempo */}
      <Escena desde={36.1} hasta={43.0}>{(f, t0) => <>
        <AbsoluteFill style={{background: PAL.papel}} />
        <Caja f={f} desde={2} x={960} y={130} tam={100} giro={-2}>COMPRA CON TIEMPO</Caja>
        <Boleto f={f} desde={k(37.4, t0)} x={720} y={520} titulo="CON ANTICIPACIÓN" precio="~20 €" nota="Milán → Venecia" color={PAL.verde} marca="si" marcaDesde={k(40.2, t0)} giro={-4} />
        <Boleto f={f} desde={k(40.8, t0)} x={1340} y={560} titulo="EL MISMO DÍA" precio="40 €+" nota="hasta el doble" color={PAL.rojo} marca="no" marcaDesde={k(42.4, t0)} giro={4} />
        <SantiEn f={f} t0={t0} x={1780} alto={660} pose="explica" expr={f > k(40.8, t0) ? 'ojo' : 'neutral'} espejo />
      </>}</Escena>

      {/* 9. ANIM: la tasa: abril a julio, 5 € / 10 € */}
      <Escena desde={43.0} hasta={51.75}>{(f, t0) => {
        const meses = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
        const marca = k(45.1, t0);
        return <>
          <AbsoluteFill style={{background: PAL.papel}} />
          <Texto f={f} desde={2} x={760} y={120} tam={100} entrada="golpe">LA TASA DE VENECIA</Texto>
          <div style={{position: 'absolute', left: 180, top: 220, display: 'grid', gridTemplateColumns: 'repeat(6, 170px)', gap: 16, opacity: entra(f, 4, 10)}}>
            {meses.map((m, i) => {
              const on = i >= 3 && i <= 6 && f >= marca + (i - 3) * 5;
              return <div key={m} style={{height: 120, borderRadius: 14, background: on ? PAL.amarillo : '#F4E9D8', fontFamily: F.bebas, fontSize: 64, color: PAL.tinta,
                display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${on ? 1.06 : 1})`}}>{m}</div>;
            })}
          </div>
          <Texto f={f} desde={marca + 22} x={760} y={560} tam={46} fuente="mont" color="#7A6A5C">SOLO DE ABRIL A JULIO · VISITANTES DE UN DÍA</Texto>
          <Boleto f={f} desde={k(46.5, t0)} x={470} y={800} titulo="4 DÍAS ANTES O MÁS" precio="5 €" nota="reserva con tiempo" color={PAL.verde} giro={-3} />
          <Boleto f={f} desde={k(49.86, t0)} x={1060} y={820} titulo="ÚLTIMA HORA" precio="10 €" nota="los últimos 3 días" color={PAL.rojo} giro={3} />
          <SantiEn f={f} t0={t0} x={1680} alto={700} pose="bolsillos" expr={f > k(49.86, t0) ? 'ojo' : 'duda'} espejo />
        </>;
      }}</Escena>

      {/* 10. ANIM: el truco: si duermes en Venecia no pagas (QR gratis) */}
      <Escena desde={51.75} hasta={57.85}>{(f, t0) => <>
        <FondoVenecia f={f + 300} />
        <AbsoluteFill style={{background: 'rgba(234,215,188,0.55)'}} />
        <Caja f={f} desde={k(51.86, t0)} x={960} y={120} tam={110} fondo={PAL.tinta} color="#fff">EL TRUCO</Caja>
        {f >= k(53.2, t0) && (
          <svg width="420" height="260" style={{position: 'absolute', left: 520, top: 300, transform: `scale(${pop(f, 30, k(53.2, t0))})`}}>
            <rect x="10" y="120" width="400" height="90" rx="16" fill={PAL.arenaOsc} /><rect x="30" y="80" width="360" height="60" rx="20" fill="#F7F1E6" />
            <rect x="40" y="70" width="110" height="50" rx="20" fill="#FFFFFF" /><rect x="10" y="40" width="30" height="200" rx="10" fill={PAL.tinta} />
            <rect x="20" y="200" width="20" height="50" fill={PAL.tinta} /><rect x="380" y="200" width="20" height="50" fill={PAL.tinta} />
          </svg>
        )}
        <Texto f={f} desde={k(53.26, t0)} x={730} y={630} tam={86}>¿DUERMES EN VENECIA?</Texto>
        <Caja f={f} desde={k(54.3, t0)} x={730} y={760} tam={130} fondo={PAL.verde} color="#fff" giro={-3}>NO PAGAS</Caja>
        {f >= k(56.0, t0) && (
          <div style={{position: 'absolute', left: 1320, top: 520, transform: `translate(-50%,-50%) rotate(4deg) scale(${pop(f, 30, k(56.0, t0))})`, background: '#fff', padding: 24, borderRadius: 18}}>
            <QR tam={260} />
            <div style={{fontFamily: F.mont, fontWeight: 800, fontSize: 30, textAlign: 'center', marginTop: 10, color: PAL.tinta}}>REGISTRO GRATIS</div>
          </div>
        )}
        <SantiEn f={f} t0={t0} x={1700} alto={700} pose="senala" desdePose="bolsillos" expr="sonrisa" espejo />
      </>}</Escena>

      {/* 11. REAL: Venecia, parecen imposibles */}
      {([[57.85, 60.0, 'milan/f32.jpg', [50, 60]], [60.0, 62.15, 'milan/f22.jpg', [50, 55]], [62.15, 64.3, 'milan/f33.jpg', [50, 45]]] as [number, number, string, [number, number]][]).map(([a, b, src, foco], i) => (
        <Escena key={i} desde={a} hasta={b}>{(f, t0) => <>
          <FotoReal f={f} dur={80} src={src} foco={foco} zoom={[1.0, 1.14]} />
          {i === 0 && <><Velo y={940} alto={220} op={0.4} /><Texto f={f} desde={8} x={960} y={950} tam={64} fuente="playfair" color="#fff" entrada="sube">la has visto mil veces en fotos…</Texto></>}
          {i === 2 && <><Velo y={540} alto={300} op={0.35} /><Texto f={f} desde={k(62.84, t0)} x={960} y={540} tam={130} fuente="playfair" peso={700} color="#fff" entrada="sube">parecen imposibles</Texto></>}
        </>}</Escena>
      ))}

      {/* 12. REAL + ANIM: ¿te armo la ruta? comenta RUTA */}
      <Escena desde={64.3} hasta={67.85}>{(f, t0) => <>
        <AbsoluteFill style={{background: PAL.papel}} />
        <div style={{position: 'absolute', left: 120, top: 110, width: 600, background: '#fff', padding: '22px 22px 80px', transform: `rotate(-4deg) scale(${pop(f, 30, 0)})`}}>
          <Img src={staticFile('milan/f20.jpg')} style={{width: '100%', height: 640, objectFit: 'cover', filter: 'saturate(1.1) brightness(1.05) sepia(0.1)'}} />
          <div style={{position: 'absolute', bottom: 18, left: 0, right: 0, textAlign: 'center', fontFamily: F.playfair, fontStyle: 'italic', fontSize: 44, color: PAL.tinta}}>Venecia, 2023</div>
        </div>
        <Texto f={f} desde={2} x={1230} y={260} tam={70} fuente="playfair">¿Te armo la ruta completa?</Texto>
        <Texto f={f} desde={k(66.2, t0)} x={1230} y={400} tam={64} fuente="mont" color="#7A6A5C">COMENTA</Texto>
        <Caja f={f} desde={k(66.4, t0)} x={1230} y={530} tam={190} giro={-3}>RUTA</Caja>
        <Texto f={f} desde={k(66.6, t0)} x={1230} y={700} tam={36} fuente="mont" color="#9C8466">RODI CLUB · rodiclub.com</Texto>
        <SantiEn f={f} t0={t0} x={1720} alto={700} pose="senala" desdePose="bolsillos" expr="sonrisa" espejo />
      </>}</Escena>

      {/* 13. FIRMA: Nos vemos pues */}
      <Escena desde={67.85} hasta={DURACION_S}>{(f, t0) => <>
        <FondoVenecia f={f + 600} />
        <AbsoluteFill style={{background: 'rgba(234,215,188,0.35)'}} />
        <Texto f={f} desde={4} x={1150} y={360} tam={150} fuente="playfair" peso={700} entrada="sube">Nos vemos pues</Texto>
        <Texto f={f} desde={20} x={1150} y={490} tam={44} fuente="mont" color={PAL.tinta} espaciado={8}>SANTIAGO RODAS</Texto>
        <SantiEn f={f} t0={t0} x={480} alto={740} pose="senala" expr="sonrisa" />
      </>}</Escena>

      <Grano frame={fg} />
    </AbsoluteFill>
  );
};
