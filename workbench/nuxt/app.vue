<template>
  <div>
    <h1>Workflow DevKit + Nitro + Nuxt Example</h1>
    <hr />
    <textarea v-model="output" readonly placeholder="output"></textarea>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const output = ref('')

onMounted(async () => {
  const { runId } = await fetchAndLog(
    '/api/trigger?workflowFile=workflows/0_calc.ts&workflowFn=calc&args=2',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    }
  )

  if (runId) {
    log('Getting workflow status with runId:', runId)
    await fetchAndLog(`/api/trigger?runId=${runId}`)
  }
})

function log(...args) {
  output.value +=
    args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ') + '\n'
}

function tryFormatJSON(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

async function fetchAndLog(input, init) {
  try {
    log(`[${init?.method || 'GET'}] ${input}`)
    const res = await fetch(input, init)
    const text = await res.text()

    if (res.ok) {
      log('Response:', tryFormatJSON(text))
      return JSON.parse(text)
    } else {
      log('Error', res.status, res.statusText, tryFormatJSON(text))
    }
  } catch (error) {
    log('Fetch error:', error.toString())
  }
  return {}
}
</script>

<style scoped>
textarea {
  width: 100%;
  height: calc(100vh - 140px);
  max-height: calc(100vh - 140px);
  box-sizing: border-box;
  padding: 8px;
  font-family: monospace;
  font-size: 14px;
  resize: none;
  overflow: auto;
}
</style>
