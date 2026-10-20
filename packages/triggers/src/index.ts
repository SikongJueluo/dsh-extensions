/**
 * dsh-triggers — structured handoff signals between two bound sessions.
 *
 * Layer A of the package: the durable data model (`model.ts`) and the pure
 * loop state machine (`engine.ts`). The host wiring (tool, events, delivery,
 * channel) and the browser editor mount in later layers of the same package.
 *
 * @module dsh-triggers
 */

export * from './identity.js'
export * from './model.js'
export * from './engine.js'
