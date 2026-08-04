/**
 * KAR-00.6 — the real-shaped, deliberately misformatted Vue SFCs this spike
 * runs `biome check --write` over. Exported as strings rather than files on
 * disk so the exact same bytes seed both the automated integration test and
 * the `spike/s7-biome-vue` scratch branch's "before" commit — one source of
 * truth for what was actually reformatted.
 */

/**
 * `<script setup lang="ts">` with the case story's AC3 names first: a generic
 * interface with a constrained, defaulted type parameter, a generic function
 * with two type parameters and a recursive call, and a template-literal union
 * type — the shapes that a formatter built for plain HTML/JS can mangle
 * inside a `.vue` file's embedded TypeScript.
 */
export const COMPLEX_GENERICS_VUE = `<script setup lang="ts">
import {ref,computed} from 'vue'

interface GraphNode<TPayload extends Record<string,unknown> = Record<string,unknown>> {
  id:string
  payload:TPayload
  children:GraphNode<TPayload>[]
}

function collect<TPayload,TResult>(nodes:GraphNode<TPayload>[],project:(node:GraphNode<TPayload>)=>TResult):Map<string,TResult>{
const out=new Map<string,TResult>()
for(const node of nodes){
out.set(node.id,project(node))
if(node.children.length>0){
for(const [id,value] of collect(node.children,project)){out.set(id,value)}
}
}
return out
}

const nodes=ref<GraphNode<{label:string;status:'pending'|'running'|'done'}>[]>([])
const doneCount=computed<number>(()=>collect(nodes.value,(n)=>n.payload.status).size)
</script>

<template>
  <div>{{ doneCount }}</div>
</template>
`;

/**
 * A template whose single element carries six attributes, one of them a long
 * utility-class string — the shape the epic names as the other formatter
 * footgun: a long attribute list reflowed unreadably instead of one
 * attribute per line.
 */
export const LONG_ATTRS_VUE = `<script setup lang="ts">
defineProps<{ disabled?: boolean }>()
const handleClick = () => {}
</script>

<template>
  <button type="button" class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500" :disabled="disabled" data-testid="submit-button" aria-label="Submit the current form and advance to the next onboarding step" @click="handleClick">Submit</button>
</template>
`;

/**
 * Options-API `components: { UnusedWidget }` registration whose template
 * never renders `<UnusedWidget>`. A plain-JS reading of the `<script>` block
 * sees `UnusedWidget` referenced (the object-shorthand property), so a
 * script-only linter has no unused binding to report — the component is only
 * dead from the template's point of view, which is exactly the cross-check
 * `vue/no-unused-components` makes and oxlint cannot (AC5, test plan #4).
 */
export const UNUSED_COMPONENT_VUE = `<script lang="ts">
import { defineComponent } from 'vue';
import UnusedWidget from './UnusedWidget.vue';

export default defineComponent({
  name: 'UnusedComponentDemo',
  components: { UnusedWidget },
});
</script>

<template>
  <section>
    <p>UnusedWidget is registered above but never appears here.</p>
  </section>
</template>
`;

/** A real, unused local binding — the exact shape both linters can see. */
export const UNUSED_VARIABLE_TS = `export function ready(): boolean {
  const unusedGuard = true;
  return true;
}
`;
