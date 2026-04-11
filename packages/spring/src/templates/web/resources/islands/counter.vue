<template>
  <div>
    <p>Vue Island</p>
    <p>Current count: {{ count }}</p>
    <button @click="increment">Increment</button>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'

const count = ref(0)

const increment = () => {
  count.value++
}
</script>
<style scoped>
  div {
    border: 1px solid var(--bg-feature);
    padding: 10px;
    border-radius: 5px;
    margin: 20px 0;
  }
  h1 {
    color: red;
    font-size: 18px;
  }
  button {
    padding: 5px 10px;
  }
</style>