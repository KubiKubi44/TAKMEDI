// Balíček `server-only` v testech nedává smysl – vitest běží v Node, ne
// v prohlížeči, ale jeho výchozí export je připravený pro bundler a zde
// by vyhodil chybu. Nahrazuje se tedy prázdným modulem.
export {}
