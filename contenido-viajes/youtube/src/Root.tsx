import React from 'react';
import {Composition} from 'remotion';
import {PruebaEgipto} from './PruebaEgipto';
import {MilanVenecia, DURACION_S} from './milan/MilanVenecia';
import {VeneciaTasa, DURACION_V2} from './milan/VeneciaTasa';

export const Root: React.FC = () => (
  <>
    <Composition id="VeneciaTasa" component={VeneciaTasa} durationInFrames={Math.round(DURACION_V2 * 30)} fps={30} width={1920} height={1080} />
    <Composition id="MilanVenecia" component={MilanVenecia} durationInFrames={Math.round(DURACION_S * 30)} fps={30} width={1920} height={1080} />
    <Composition id="PruebaEgipto" component={PruebaEgipto} durationInFrames={540} fps={30} width={1920} height={1080} />
  </>
);
