type A = {
    a: string
    b: boolean
}

/**
 * @title AA
 */
type B = {
    a: string
    /** @oaksdoakds */
    b: number
}

type Props = {
    /**
     * @title A - COMMENTs
     * @ignore
     * @titleBy {{ soadkoaskdo as | }}
     */
    a: string
    
    /**
     * @title Intersection reference
     */
    b: A & B
}
