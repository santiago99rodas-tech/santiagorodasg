import React from 'react';
import {Composition} from 'remotion';
import {PruebaEgipto} from './PruebaEgipto';
import {MilanVenecia, DURACION_S} from './milan/MilanVenecia';
import {VeneciaTasa, DURACION_V2} from './milan/VeneciaTasa';
import {VeneciaTasaV3, DURACION_V3} from './milan/VeneciaTasaV3';

export const Root: React.FC = () => (
  <>
    <Composition id="VeneciaTasaV3" component={VeneciaTasaV3} durationInFrames={Math.round(DURACION_V3 * 30)} fps={30} width={1920} height={1080} />
    <Composition id="VeneciaTasa" component={VeneciaTasa} durationInFrames={Math.round(DURACION_V2 * 30)} fps={30} width={1920} height={1080} />
    <Composition id="MilanVenecia" component={MilanVenecia} durationInFrames={Math.round(DURACION_S * 30)} fps={30} width={1920} height={1080} />
    <Composition id="PruebaEgipto" component={PruebaEgipto} durationInFrames={540} fps={30} width={1920} height={1080} />
  </>
);
