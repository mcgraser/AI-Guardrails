<!--
  Bahmüller logo (FLOW + wordmark), rendered inline so it also works inside
  closed Shadow Roots on third-party pages. Path data comes 1:1 from the CI
  manual vector artwork (bahmueller-logo-paths.ts).

  CI rules honoured here (CI manual 6.1):
  - the elements of the logo are never changed or recoloured individually;
    only the CI-sanctioned positive (black wordmark, grey FLOW/SPAN) and
    negative (white on grey/dark) treatments are offered;
  - the protection zone A (cap height of the wordmark, ~0.66 x logo height)
    must stay free — callers reserve it via padding/margins, the component
    adds no padding of its own so it does not shift layouts.
-->
<script lang="ts">
	import {
		BAHMUELLER_LOGO_ASPECT,
		BAHMUELLER_LOGO_FLOW_PATHS,
		BAHMUELLER_LOGO_SPAN_PATHS,
		BAHMUELLER_LOGO_VIEWBOX,
		BAHMUELLER_LOGO_WORDMARK_PATHS,
	} from './bahmueller-logo-paths';

	let {
		height = 16,
		variant = 'positive',
		title = 'BAHMÜLLER',
	}: { height?: number; variant?: 'positive' | 'negative'; title?: string } = $props();

	const wordFill = $derived(variant === 'negative' ? '#ffffff' : '#19191c');
	const flowFill = $derived(variant === 'negative' ? '#e1e1e1' : '#949497');
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox={BAHMUELLER_LOGO_VIEWBOX}
	{height}
	width={Math.round(height * BAHMUELLER_LOGO_ASPECT * 100) / 100}
	class="bm-logo"
	role="img"
	aria-label={title}
>
	<title>{title}</title>
	{#each BAHMUELLER_LOGO_FLOW_PATHS as d}
		<path fill={flowFill} fill-rule="evenodd" {d} />
	{/each}
	{#each BAHMUELLER_LOGO_WORDMARK_PATHS as d}
		<path fill={wordFill} fill-rule="evenodd" {d} />
	{/each}
	{#each BAHMUELLER_LOGO_SPAN_PATHS as d}
		<path fill={flowFill} fill-rule="evenodd" {d} />
	{/each}
</svg>

<style>
	.bm-logo {
		display: block;
		width: auto;
		flex-shrink: 0;
	}
</style>
