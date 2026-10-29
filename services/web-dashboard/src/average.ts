/**
 * What a chart's trailing average bar divides by: every period on the chart ("all", empty ones counting as 0), or only
 * the periods with money in them ("active"), so quiet stretches don't drag it down.
 */
export type AverageOver = 'all' | 'active';
