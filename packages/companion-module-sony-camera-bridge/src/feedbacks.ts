import { combineRgb } from '@companion-module/base'
import type { ModuleInstance } from './main.js'

export function updateFeedbacks(self: ModuleInstance): void {
  self.setFeedbackDefinitions({
    bridge_connected: {
      type: 'boolean',
      name: 'Bridge reachable',
      defaultStyle: {
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(0, 102, 204),
      },
      options: [],
      callback: () => self.bridgeConnected,
    },
    camera_connected: {
      type: 'boolean',
      name: 'Camera connected',
      defaultStyle: {
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(0, 153, 0),
      },
      options: [],
      callback: () => self.cameraConnected,
    },
    tally_program: {
      type: 'boolean',
      name: 'Program tally active',
      defaultStyle: {
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(204, 0, 0),
      },
      options: [],
      callback: () => self.tallyState.program === true,
    },
    tally_preview: {
      type: 'boolean',
      name: 'Preview tally active',
      defaultStyle: {
        color: combineRgb(0, 0, 0),
        bgcolor: combineRgb(0, 204, 0),
      },
      options: [],
      callback: () => self.tallyState.preview === true,
    },
    tally_iso_rec: {
      type: 'boolean',
      name: 'ISO record active',
      defaultStyle: {
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(255, 102, 0),
      },
      options: [],
      callback: () => self.tallyState.isoRec === true,
    },
    // ADR-003 — der Fall, den die drei Feedbacks oben nicht ausdruecken
    // koennen. Sie sind boolesch: „unbestaetigt" sieht dort aus wie „aus",
    // und eine dunkle Tally-Lampe liest sich als Freigabe. Dieses Feedback
    // macht den Unterschied sichtbar, damit ein Button ihn zeigen kann
    // (Vorschlag: Amber). Es ersetzt keine der drei, es steht daneben.
    tally_unknown: {
      type: 'boolean',
      name: 'Tally state unconfirmed',
      description:
        'True while the bridge has not confirmed the tally state — before the first poll, or when /api/tally answered without a tally field. A dark program lamp does NOT mean "off" while this is true.',
      defaultStyle: {
        color: combineRgb(0, 0, 0),
        bgcolor: combineRgb(255, 191, 0),
      },
      options: [],
      callback: () =>
        self.tallyState.program === undefined ||
        self.tallyState.preview === undefined ||
        self.tallyState.isoRec === undefined,
    },
  })
}
