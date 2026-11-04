import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail, IsIn, IsNotEmpty, IsNumber,
  IsString, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export const PREFERRED_ENERGY_TYPES = [
  'SOLAR', 'WIND', 'HYDRO', 'GRID', 'MIXED', 'ANY',
] as const;

export class RegisterDto {
  @ApiProperty({ example: 'Solar House' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiProperty({ example: 'solar@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 12, writeOnly: true, example: 'LongRandomPassword123!' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Simulated Street 1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  physicalAddress!: string;

  @ApiProperty({ example: 2.5 })
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-1000000)
  @Max(1000000)
  xKm!: number;

  @ApiProperty({ example: 4 })
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-1000000)
  @Max(1000000)
  yKm!: number;

  @ApiProperty({ enum: [...PREFERRED_ENERGY_TYPES], example: 'SOLAR' })
  @IsIn(PREFERRED_ENERGY_TYPES)
  preferredEnergyType!: (typeof PREFERRED_ENERGY_TYPES)[number];
}
