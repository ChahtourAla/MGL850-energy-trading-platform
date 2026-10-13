import { IsEmail, IsString, MinLength, IsOptional, IsNumber } from 'class-validator';

export class CreateUserDto {
  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8, {
    message: 'Le mot de passe doit contenir au moins 8 caractères',
  })
  password!: string;

  @IsOptional()
  @IsString()
  physicalAddress?: string;

  @IsOptional()
  @IsNumber()
  xKm?: number;

  @IsOptional()
  @IsNumber()
  yKm?: number;

  @IsOptional()
  @IsString()
  preferredEnergyType?: string;
}
