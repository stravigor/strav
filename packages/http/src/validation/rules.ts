import { t } from '@strav/kernel/i18n/helpers'

export interface Rule {
  name: string
  validate(value: unknown): string | null
  /**
   * Optional pre-validation transform. Form bodies arrive as strings, so
   * type-shape rules (integer, number, boolean) coerce strings to their
   * native types before validate() runs. validate() writes the coerced
   * value into the returned `data`, so handlers receive typed input.
   *
   * Coercion is best-effort: if the input cannot be coerced (e.g. "abc"
   * for integer()), the original value is returned and validate() rejects
   * it. Empty strings are passed through so required() still owns
   * emptiness.
   */
  coerce?(value: unknown): unknown
}

export function required(): Rule {
  return {
    name: 'required',
    validate(value) {
      if (value === undefined || value === null || value === '') {
        return t('validation.required')
      }
      return null
    },
  }
}

export function string(): Rule {
  return {
    name: 'string',
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value !== 'string') return t('validation.string')
      return null
    },
  }
}

export function integer(): Rule {
  return {
    name: 'integer',
    coerce(value) {
      if (typeof value !== 'string' || value.trim() === '') return value
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    },
    validate(value) {
      if (value === undefined || value === null || value === '') return null
      if (typeof value !== 'number' || !Number.isInteger(value)) return t('validation.integer')
      return null
    },
  }
}

export function number(): Rule {
  return {
    name: 'number',
    coerce(value) {
      if (typeof value !== 'string' || value.trim() === '') return value
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    },
    validate(value) {
      if (value === undefined || value === null || value === '') return null
      if (typeof value !== 'number' || isNaN(value)) return t('validation.number')
      return null
    },
  }
}

export function boolean(): Rule {
  return {
    name: 'boolean',
    coerce(value) {
      if (typeof value !== 'string') return value
      const v = value.toLowerCase()
      if (v === 'true' || v === '1' || v === 'on') return true
      if (v === 'false' || v === '0' || v === 'off') return false
      return value
    },
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value !== 'boolean') return t('validation.boolean')
      return null
    },
  }
}

export function min(n: number): Rule {
  return {
    name: 'min',
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value === 'number') {
        if (value < n) return t('validation.min.number', { min: n })
      } else if (typeof value === 'string') {
        if (value.length < n) return t('validation.min.string', { min: n })
      }
      return null
    },
  }
}

export function max(n: number): Rule {
  return {
    name: 'max',
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value === 'number') {
        if (value > n) return t('validation.max.number', { max: n })
      } else if (typeof value === 'string') {
        if (value.length > n) return t('validation.max.string', { max: n })
      }
      return null
    },
  }
}

export function email(): Rule {
  return {
    name: 'email',
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value !== 'string') return t('validation.string')
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return t('validation.email')
      return null
    },
  }
}

export function url(): Rule {
  return {
    name: 'url',
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value !== 'string') return t('validation.string')
      try {
        new URL(value)
        return null
      } catch {
        return t('validation.url')
      }
    },
  }
}

export function regex(pattern: RegExp): Rule {
  return {
    name: 'regex',
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value !== 'string') return t('validation.string')
      if (!pattern.test(value)) return t('validation.regex')
      return null
    },
  }
}

export function enumOf(enumObj: Record<string, string | number>): Rule {
  const values = Object.values(enumObj)
  return {
    name: 'enumOf',
    validate(value) {
      if (value === undefined || value === null) return null
      if (!values.includes(value as any)) {
        return t('validation.enum', { values: values.join(', ') })
      }
      return null
    },
  }
}

export function oneOf(values: readonly (string | number | boolean)[]): Rule {
  return {
    name: 'oneOf',
    validate(value) {
      if (value === undefined || value === null) return null
      if (!values.includes(value as any)) {
        return t('validation.enum', { values: values.join(', ') })
      }
      return null
    },
  }
}

export function array(): Rule {
  return {
    name: 'array',
    validate(value) {
      if (value === undefined || value === null) return null
      if (!Array.isArray(value)) return t('validation.array')
      return null
    },
  }
}
